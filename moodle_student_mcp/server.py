"""MCP server exposing student-level Moodle tools.

Each tool calls a student-level web service function and returns trimmed,
English-keyed data. File tools download course materials to ./materials/ so
the MCP client (e.g. Claude Code) can read PDFs/images natively from disk.
"""

from __future__ import annotations

import html
import os
import re
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

from .client import MoodleClient

# Load the project's .env regardless of the cwd the MCP client starts us from,
# then fall back to the cwd.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_MATERIALS_DIR = _PROJECT_ROOT / "materials"
load_dotenv(_PROJECT_ROOT / ".env")
load_dotenv()

mcp = FastMCP("moodle-student")

_CLIENT: Optional[MoodleClient] = None


def _client() -> MoodleClient:
    global _CLIENT
    if _CLIENT is None:
        url = os.getenv("MOODLE_URL")
        token = os.getenv("MOODLE_TOKEN")
        if not url or not token:
            raise RuntimeError(
                "MOODLE_URL and MOODLE_TOKEN are not set. Run: "
                "python -m moodle_student_mcp.token_helper --url <your-moodle-url>"
            )
        _CLIENT = MoodleClient(url, token)
    return _CLIENT


# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #

def _fmt_ts(ts) -> Optional[str]:
    """Unix timestamp -> 'YYYY-MM-DD HH:MM'. 0/None become None (= 'no date')."""
    if not ts:
        return None
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(int(ts)))
    except (ValueError, OSError):
        return None


def _strip_html(text) -> Optional[str]:
    """Strip HTML tags and collapse whitespace into readable text."""
    if not text:
        return None
    text = re.sub(r"<[^>]+>", " ", str(text))
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def _safe_name(name) -> str:
    """Sanitize a string for use as a file/folder name on Windows."""
    name = str(name).replace("\n", " ")
    name = re.sub(r'[\\/:*?"<>|]+', "_", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:150] or "file"


def _all_course_ids(client: MoodleClient) -> list[int]:
    courses = client.call("core_enrol_get_users_courses", userid=client.userid)
    return [course["id"] for course in courses]


def _course_folder(client: MoodleClient, course_id: int) -> str:
    """A readable, unique folder name for a course's downloaded materials."""
    try:
        for course in client.call("core_enrol_get_users_courses", userid=client.userid):
            if course.get("id") == course_id:
                label = course.get("shortname") or course.get("fullname") or ""
                # Some sites repeat the verbose name with class code/time on
                # later lines — keep just the readable first line.
                label = label.split("\n")[0].strip()
                return _safe_name(f"{course_id} - {label}")
    except Exception:
        pass
    return str(course_id)


def _iter_course_files(sections) -> list:
    """Flatten all downloadable file entries from core_course_get_contents."""
    files = []
    for section in sections:
        for module in section.get("modules", []):
            for content in module.get("contents", []):
                if content.get("type") == "file" and content.get("fileurl"):
                    files.append((section, module, content))
    return files


# --------------------------------------------------------------------------- #
# Tools
# --------------------------------------------------------------------------- #

@mcp.tool()
def whoami() -> dict:
    """Confirm who you are on Moodle and that the token is valid.

    Returns your name, user_id, site name, version and how many web service
    functions your token may call. Use it to diagnose the connection.
    """
    client = _client()
    info = client.call("core_webservice_get_site_info")
    return {
        "user_id": info.get("userid"),
        "name": info.get("fullname"),
        "username": info.get("username"),
        "site": info.get("sitename"),
        "url": info.get("siteurl"),
        "version": info.get("release"),
        "available_functions": len(info.get("functions", [])),
    }


@mcp.tool()
def list_courses() -> list:
    """List the courses you are enrolled in.

    For each: id (use it in the other tools), name, short name, progress (%)
    and last access date.
    """
    client = _client()
    courses = client.call("core_enrol_get_users_courses", userid=client.userid)
    return [
        {
            "id": course.get("id"),
            "name": course.get("fullname"),
            "short_name": course.get("shortname"),
            "progress": course.get("progress"),
            "visible": bool(course.get("visible", 1)),
            "last_access": _fmt_ts(course.get("lastaccess")),
        }
        for course in courses
    ]


@mcp.tool()
def get_course_contents(course_id: int) -> list:
    """List the sections/topics and activities of a course.

    Use the `id` from list_courses. For each section, returns its activities
    (name, type, url, description and completion state when Moodle exposes it).
    """
    client = _client()
    sections = client.call("core_course_get_contents", courseid=course_id)
    out = []
    for section in sections:
        activities = []
        for module in section.get("modules", []):
            completion = (module.get("completiondata") or {}).get("state")
            activities.append(
                {
                    "name": module.get("name"),
                    "type": module.get("modname"),
                    "url": module.get("url"),
                    "completed": {0: False, 1: True, 2: True, 3: False}.get(completion),
                    "description": _strip_html(module.get("description")),
                }
            )
        out.append(
            {
                "section": section.get("name"),
                "summary": _strip_html(section.get("summary")),
                "activities": activities,
            }
        )
    return out


@mcp.tool()
def list_assignments(course_ids: Optional[list[int]] = None) -> list:
    """List assignments with their due dates.

    If `course_ids` is omitted, searches ALL your courses. Returns course,
    assignment name, assign_id (for get_submission_status), due date, cutoff
    date and max grade.
    """
    client = _client()
    if not course_ids:
        course_ids = _all_course_ids(client)
    data = client.call("mod_assign_get_assignments", courseids=course_ids)
    out = []
    for course in data.get("courses", []):
        for assignment in course.get("assignments", []):
            out.append(
                {
                    "course": course.get("fullname"),
                    "course_id": course.get("id"),
                    "name": assignment.get("name"),
                    "assign_id": assignment.get("id"),
                    "cmid": assignment.get("cmid"),
                    "due_date": _fmt_ts(assignment.get("duedate")),
                    "cutoff_date": _fmt_ts(assignment.get("cutoffdate")),
                    "opens_at": _fmt_ts(assignment.get("allowsubmissionsfromdate")),
                    "max_grade": assignment.get("grade"),
                }
            )
    return out


@mcp.tool()
def get_submission_status(assign_id: int) -> dict:
    """Show the status of YOUR submission for an assignment.

    Use the `assign_id` from list_assignments. Tells whether you submitted,
    the submission state, whether it is still editable, whether it was graded,
    the grade and the teacher's feedback. A status other than "submitted"
    means it has not been turned in yet.
    """
    client = _client()
    data = client.call("mod_assign_get_submission_status", assignid=assign_id)
    last = data.get("lastattempt") or {}
    submission = last.get("submission") or {}
    feedback = data.get("feedback") or {}

    grade = None
    if feedback.get("grade"):
        grade = feedback["grade"].get("grade")

    feedback_text = None
    for plugin in feedback.get("plugins", []):
        for field in plugin.get("editorfields", []):
            if field.get("text"):
                feedback_text = _strip_html(field["text"])

    return {
        "submission_status": submission.get("status") or last.get("submissionsstatus"),
        "submitted_at": _fmt_ts(submission.get("timemodified")),
        "can_edit": bool(last.get("canedit")),
        "graded": bool(feedback),
        "grade": grade,
        "feedback": feedback_text,
    }


@mcp.tool()
def get_upcoming_deadlines(days: int = 30) -> list:
    """List your upcoming tasks and deadlines (Moodle's "Timeline").

    Aggregates assignment due dates, quiz closings, etc., sorted by date.
    `days` is the look-ahead window (default 30). This is the best single
    source for "what do I have to do and by when".
    """
    client = _client()
    now = int(time.time())
    events = client.call(
        "core_calendar_get_action_events_by_timesort",
        timesortfrom=now,
        timesortto=now + days * 86400,
        limitnum=50,
    )
    out = []
    for event in events.get("events", []):
        course = event.get("course") or {}
        action = event.get("action") or {}
        out.append(
            {
                "event": event.get("name"),
                "course": course.get("fullname"),
                "type": event.get("modulename"),
                "when": _fmt_ts(event.get("timesort")),
                "action": action.get("name"),
                "still_pending": bool(action.get("actionable")),
                "url": event.get("url"),
            }
        )
    return out


@mcp.tool()
def get_grades(course_id: int) -> list:
    """Show your grades in a course.

    Use the `id` from list_courses. Returns each graded item with your grade,
    the max, the percentage, the weight and feedback (only YOUR grades).
    """
    client = _client()
    data = client.call(
        "gradereport_user_get_grade_items", courseid=course_id, userid=client.userid
    )
    out = []
    for report in data.get("usergrades", []):
        for item in report.get("gradeitems", []):
            out.append(
                {
                    "item": item.get("itemname") or item.get("itemtype"),
                    "grade": item.get("gradeformatted"),
                    "max": item.get("grademax"),
                    "percentage": item.get("percentageformatted"),
                    "weight": item.get("weightformatted"),
                    "feedback": _strip_html(item.get("feedback")),
                }
            )
    return out


@mcp.tool()
def list_forums(course_ids: Optional[list[int]] = None) -> list:
    """List the forums in your courses (includes news/announcements).

    If `course_ids` is omitted, scans all courses. Returns forum_id (for
    get_forum_discussions), name, type and description.
    """
    client = _client()
    if not course_ids:
        course_ids = _all_course_ids(client)
    data = client.call("mod_forum_get_forums_by_courses", courseids=course_ids)
    return [
        {
            "forum": forum.get("name"),
            "forum_id": forum.get("id"),
            "course_id": forum.get("course"),
            "type": forum.get("type"),
            "description": _strip_html(forum.get("intro")),
        }
        for forum in data
    ]


@mcp.tool()
def get_forum_discussions(forum_id: int, limit: int = 10) -> list:
    """List the recent discussions of a forum.

    Use the `forum_id` from list_forums. Good for checking teacher
    announcements. Returns title, author, date and the opening message.
    """
    client = _client()
    data = client.call(
        "mod_forum_get_forum_discussions",
        forumid=forum_id,
        sortorder=1,
        page=0,
        perpage=limit,
    )
    return [
        {
            "title": discussion.get("name"),
            "author": discussion.get("userfullname"),
            "created": _fmt_ts(discussion.get("created")),
            "message": _strip_html(discussion.get("message")),
        }
        for discussion in data.get("discussions", [])
    ]


@mcp.tool()
def list_files(course_id: int) -> list:
    """List the downloadable files of a course (PDFs, slides, notebooks, ...).

    Use the `id` from list_courses. Returns, for each file: filename, mimetype,
    size, the section/activity it belongs to, and the `fileurl` to pass to
    download_files.
    """
    client = _client()
    sections = client.call("core_course_get_contents", courseid=course_id)
    out = []
    for section, module, content in _iter_course_files(sections):
        out.append(
            {
                "filename": content.get("filename"),
                "mimetype": content.get("mimetype"),
                "size_bytes": content.get("filesize"),
                "section": section.get("name"),
                "activity": module.get("name"),
                "fileurl": content.get("fileurl"),
            }
        )
    return out


@mcp.tool()
def download_files(course_id: int, fileurls: Optional[list[str]] = None) -> list:
    """Download course files to ./materials/<course>/ and return local paths.

    Pass `fileurls` (from list_files) to download specific files, or omit it to
    download every file in the course. The MCP client can then read the local
    `path` of each result (e.g. open a PDF natively). Already-downloaded files
    of the same size are reused (status "cached").
    """
    client = _client()
    sections = client.call("core_course_get_contents", courseid=course_id)
    folder = _MATERIALS_DIR / _course_folder(client, course_id)

    selected = _iter_course_files(sections)
    if fileurls:
        wanted = set(fileurls)
        selected = [t for t in selected if t[2].get("fileurl") in wanted]

    results = []
    for _section, _module, content in selected:
        filename = _safe_name(content.get("filename") or "file")
        dest = folder / filename
        expected = content.get("filesize") or -1
        try:
            if dest.exists() and dest.stat().st_size == expected:
                results.append(
                    {
                        "filename": filename,
                        "path": str(dest),
                        "size_bytes": dest.stat().st_size,
                        "status": "cached",
                    }
                )
                continue
            size = client.download(content["fileurl"], dest)
            results.append(
                {
                    "filename": filename,
                    "path": str(dest),
                    "size_bytes": size,
                    "status": "downloaded",
                }
            )
        except Exception as exc:  # report per-file, keep going
            results.append(
                {
                    "filename": filename,
                    "path": None,
                    "size_bytes": None,
                    "status": f"error: {type(exc).__name__}: {exc}",
                }
            )
    return results


def main():
    """Server entry point (stdio transport)."""
    mcp.run()


if __name__ == "__main__":
    main()

"""Smoke test: exercise the MCP tools against your real data.

Reads MOODLE_URL/MOODLE_TOKEN from .env (does NOT print the token). Runs each
tool and prints a summary to confirm the fields match your Moodle, including a
single file download to validate the materials pipeline.

    Run with the venv Python, e.g.:  venv/Scripts/python.exe smoke_test.py
"""

import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

from moodle_student_mcp import server


def _fn(tool):
    """Unwrap the underlying function in case FastMCP wrapped it."""
    return getattr(tool, "fn", tool)


def run(label, tool, *args, **kwargs):
    print(f"\n=== {label} ===")
    try:
        return _fn(tool)(*args, **kwargs)
    except Exception as exc:
        print(f"  ERROR: {type(exc).__name__}: {exc}")
        return None


def main():
    info = run("whoami", server.whoami)
    if not info:
        print("\nwhoami failed — invalid token? Re-run token_helper.")
        sys.exit(1)
    print(f"  Logged in as: {info.get('name')} ({info.get('username')})")
    print(f"  Site: {info.get('site')} | Moodle {info.get('version')}")
    print(f"  Functions available: {info.get('available_functions')}")

    courses = run("list_courses", server.list_courses) or []
    print(f"  {len(courses)} course(s):")
    for course in courses[:12]:
        print(f"   - [{course.get('id')}] {course.get('short_name')}  ({course.get('progress')}%)")

    deadlines = run("get_upcoming_deadlines(14)", server.get_upcoming_deadlines, 14) or []
    print(f"  {len(deadlines)} deadline(s) in the next 14 days:")
    for ev in deadlines[:12]:
        flag = "pending" if ev.get("still_pending") else "ok"
        print(f"   - {ev.get('when')} | {ev.get('event')} [{flag}]")

    if not courses:
        print("\nNo courses; stopping.")
        return

    cid = courses[0]["id"]
    files = run(f"list_files({cid})", server.list_files, cid) or []
    print(f"  {len(files)} file(s) in '{courses[0].get('short_name')}':")
    for f in files[:10]:
        kb = (f.get("size_bytes") or 0) / 1024
        print(f"   - {f.get('filename')}  ({kb:.0f} KB, {f.get('mimetype')})")

    # Download the smallest non-empty file to validate the pipeline.
    candidates = [f for f in files if (f.get("size_bytes") or 0) > 0]
    if candidates:
        smallest = min(candidates, key=lambda f: f["size_bytes"])
        res = run(
            "download_files (smallest file)",
            server.download_files,
            cid,
            [smallest["fileurl"]],
        )
        if res:
            for r in res:
                print(f"   {r.get('status')}: {r.get('path')} ({r.get('size_bytes')} bytes)")
    else:
        print("\n  No downloadable files to test with.")

    print("\nSmoke test done.")


if __name__ == "__main__":
    main()

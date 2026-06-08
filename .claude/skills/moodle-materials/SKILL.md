---
name: moodle-materials
description: Download and analyze a Moodle course's materials (PDFs, slides, notebooks). Use when the user wants to understand, summarize, study, or get help with the content of a course or a specific activity/assignment.
---

# Moodle: analyze course materials

Goal: download a course's files from Moodle and analyze them by reading them
natively (the Read tool opens PDF/image/notebook for real — figures, formulas,
diagrams — not just extracted text).

Uses the `moodle-student` MCP tools plus the built-in Read tool.

## Steps

1. **Pick the course.** If the user didn't name one, call `list_courses` and
   choose the best match (or briefly ask). Keep the `id`.
2. **Discover files.** Call `list_files(course_id)` to see what's available
   (filename, mimetype, size, which section/activity it belongs to).
3. **Select what's relevant** to the user's request. Prefer PDFs, slides
   (pptx), and notebooks tied to the topic/assignment in question. If a file is
   large (> ~25 MB) or there are many, confirm with the user before downloading.
4. **Download.** Call `download_files(course_id, fileurls=[...])` with the
   chosen `fileurl`s (or omit `fileurls` to grab everything in the course).
5. **Read natively.** For each returned `path`, use the **Read** tool. For PDFs,
   read in page ranges (e.g. "1-15") for long documents; Read renders the pages
   visually. Skip files whose `status` is an error and report them.
6. **Synthesize.** Summarize, explain key points, extract requirements,
   list TODOs. If the material relates to an assignment, cross-reference with
   `list_assignments` / `get_submission_status` to tie it to the deadline.

## Notes
- Reply in the user's language.
- Files land under `materials/<course>/`; mention which files you actually read.
- Never print or expose the Moodle token.
- If `list_files` is empty, the course may use links/labels instead of files —
  fall back to `get_course_contents` and report the activity URLs.

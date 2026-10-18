---
name: moodle-study
description: Build a study guide from a course's materials — a summary, key concepts, flashcards and practice questions for a topic or exam. Use when the user wants to study, review, prepare for a test/exam, or "make me a study guide / flashcards" from Moodle content.
---

# Moodle: study guide / exam prep

Goal: turn a course's slides and materials into an effective study aid for a
topic or an upcoming exam. Builds on the `moodle-materials` flow but is
aimed at *learning/reviewing*, not just downloading.

Uses the `moodle-student` MCP tools plus your file-reading tool (in Claude Code,
the Read tool).

## Steps

1. **Scope it.** Determine the course and the topic/exam. If unclear, call
   `list_courses` and ask or infer. If it's for an exam, check
   `get_upcoming_deadlines` and the course's announcements forum
   (`list_forums` → the forum with `type == "news"` → `get_forum_discussions`)
   for the date, so the guide can be time-boxed.
2. **Locate materials.** `get_course_contents(course_id)` to find the sections
   for the topic; `list_files(course_id)` for the downloadable slides/PDFs.
3. **Download the relevant files.** `download_files(course_id, fileurls=[...])`,
   preferring slides and the topic's resources. Confirm before downloading many
   or very large files.
4. **Read them natively.** Open each `path` (long PDFs by page ranges), so
   figures and diagrams are seen, not just text.
5. **Produce the study guide** (section titles in the user's language):
   - **Summary** — concise summary per subtopic.
   - **Key concepts** — terms and definitions.
   - **Flashcards** — question → answer pairs.
   - **Practice questions** — with an answer key at the end (not inline).
   - **Review plan** — if there's an exam date, a short day-by-day plan.
6. **Save it (optional).** Offer to write the guide to
   `study/<course>-<topic>.md` so the user keeps it.

## Notes
- Reply in the user's language.
- Cite which materials (filenames/slides) you used so the user can go deeper.
- Base the content on what's actually in the materials; if something isn't
  covered, say so rather than inventing it.
- If a tool says the user is not signed in, follow the `moodle-setup` skill.

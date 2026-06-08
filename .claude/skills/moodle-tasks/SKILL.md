---
name: moodle-tasks
description: Review pending Moodle work for the week and build an execution plan for the next deadline. Use when the user asks what's due, what's left to do, their deadlines, how to organize their tasks, or wants a study/work plan.
---

# Moodle: pending work and plan

Goal: turn the user's Moodle into a prioritized, actionable view of what's due,
and optionally a concrete plan for the next deadline.

Uses the `moodle-student` MCP tools (and, for planning, the Read tool via the
`moodle-materials` workflow).

## Steps

1. **(Optional) Confirm connection** with `whoami` if not already verified this
   session.
2. **Get the timeline.** Call `get_upcoming_deadlines(days=N)` — default N=14,
   widen/narrow to match the request.
3. **Get full due dates.** Call `list_assignments()` and reconcile with the
   timeline (the timeline only shows dated, actionable events).
4. **Check what's done.** For each near-term assignment, call
   `get_submission_status(assign_id)`. A `submission_status` other than
   "submitted" means it is NOT turned in yet — flag it.
5. **Catch undated assignments.** Some courses leave assignments with NO due
   date, so they never appear in get_upcoming_deadlines. For each course, also
   call `list_assignments([course_id])` and run `get_submission_status` on every
   assignment to find the pending ones. Status map: `"submitted"` = done;
   `"new"` = draft saved but NOT submitted (pending); `null`/empty = never
   opened (pending). If some assignments in the course already show
   `"submitted"`, the course uses the submit-for-grading flow, so `"new"`
   genuinely means not turned in.
6. **Find announced dates.** When assignments lack a due date, professors
   usually post deadlines/presentation dates as plain text in the announcements
   forum. Call `list_forums([course_id])`, pick the forum with `type == "news"`
   (usually "Avisos"), and `get_forum_discussions(forum_id)` to read them.
7. **Prioritize and present.** Show a clear table: task, course, due date (or
   "announced in Avisos: <date>" / "no date"), status (submitted / pending /
   graded). Sort by due date. Use **absolute dates** and call out anything
   overdue or due within 48h.
8. **Plan (on request).** For the next deadline, pull the assignment's material
   (`list_files` + `download_files`, then Read the brief/PDF) and produce a
   realistic step-by-step plan with time estimates up to the due date.

## Notes
- Always reply to the user in **Portuguese (pt-BR)**.
- Course names from Moodle are verbose (they embed class code, weekday, time,
  professor); show a short, clean course label in tables.
- Items with no due date won't appear in get_upcoming_deadlines — that's why
  steps 5–6 cross-check submission status and the "Avisos" forum. Always do this
  for a complete picture; never rely on the timeline alone.
- Never expose the Moodle token.

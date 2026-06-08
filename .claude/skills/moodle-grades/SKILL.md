---
name: moodle-grades
description: Show the student's grades across courses and compute current standing and what's needed to pass or hit a target. Use when the user asks about grades, marks, current average, "am I passing", or "what do I need on the final".
---

# Moodle: grades and projections

Goal: give a clear picture of grades across courses and, on request, compute
what's still needed to reach a target.

Uses the `moodle-student` MCP tools.

## Steps

1. **List courses.** Call `list_courses` to get ids and names.
2. **Pull grades.** For each course (or the one asked about), call
   `get_grades(course_id)`. Present a per-course table: item, grade/max,
   percentage, weight, feedback. Separate **graded** items from **empty**
   (not yet graded / pending) ones.
3. **Surface the overall structure.** Look for category or "Total" rows in the
   gradebook to report consolidated/term grades. Some institutions split a
   course into terms or partial grades that average into the final — reflect
   whatever structure the gradebook actually shows.
4. **Projection (on request).** If the user asks "what do I need":
   - Identify the grades already in and the weights shown in the gradebook.
   - Ask for the **passing/target threshold** if it isn't known (don't assume a
     fixed number — it varies by institution/course; the syllabus or grading-
     agreement PDF in the course usually states it, and can be read via the
     `moodle-materials` flow if needed).
   - Compute the grade still required to reach the target, using the actual
     weights. Show the arithmetic.
5. **Highlight risk.** Flag courses where the current standing is below target or
   where many items are still ungraded.

## Notes
- Reply in the user's language.
- Only report grades that `get_grades` actually returns; never invent a number.
  If an item is hidden by the teacher or not released, say so.
- Course names from Moodle are verbose — show a short, clean label in tables.
- A grade of `null`/empty means "not graded yet", not zero — don't treat it as 0
  unless the user confirms the assessment was missed.

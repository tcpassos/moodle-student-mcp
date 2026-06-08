---
name: moodle-study
description: Build a study guide from a course's materials — a summary, key concepts, flashcards and practice questions for a topic or exam. Use when the user wants to study, review, prepare for a test/Grau, or "make me a study guide / flashcards" from Moodle content.
---

# Moodle: study guide / exam prep

Goal: turn a course's slides and materials into an effective study aid for a
topic or an upcoming exam (Grau). Builds on the `moodle-materials` flow but is
aimed at *learning/reviewing*, not just downloading.

Uses the `moodle-student` MCP tools plus the built-in Read tool.

## Steps

1. **Scope it.** Determine the course and the topic/exam. If unclear, call
   `list_courses` and ask or infer. If it's for an exam, check
   `get_upcoming_deadlines` and the "Avisos" forum (`list_forums` →
   `get_forum_discussions`) for the date, so the guide can be time-boxed.
2. **Locate materials.** `get_course_contents(course_id)` to find the sections
   for the topic; `list_files(course_id)` for the downloadable slides/PDFs.
3. **Download the relevant files.** `download_files(course_id, fileurls=[...])`,
   preferring slides and the topic's resources. Confirm before downloading many
   or very large files.
4. **Read them natively.** Use the **Read** tool on each `path` (PDFs by page
   ranges for long decks). Read renders figures/diagrams, not just text.
5. **Produce the study guide:**
   - **Resumo** — concise summary per subtopic.
   - **Conceitos-chave** — terms and definitions.
   - **Flashcards** — pergunta → resposta pairs.
   - **Questões de prática** — with an answer key at the end (not inline).
   - **Plano de revisão** — if there's an exam date, a short day-by-day plan.
6. **Save it (optional).** Offer to write the guide to
   `study/<course>-<topic>.md` so the user keeps it.

## Notes
- Always reply to the user in **Portuguese (pt-BR)**.
- Cite which materials (filenames/slides) you used so the user can go deeper.
- Base the content on what's actually in the materials; if something isn't
  covered, say so rather than inventing it.
- Don't expose the Moodle token. Downloaded files live under `materials/`
  (git-ignored); generated guides under `study/`.

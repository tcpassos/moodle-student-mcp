---
name: moodle-digest
description: A proactive briefing of what's new and what's coming on Moodle — recent announcements, upcoming deadlines, unsubmitted work, and new/changed grades. Use for a periodic check-in or when the user asks "what's new", "did I miss anything", or "give me a Moodle summary". Pairs with scheduled runs (e.g. /schedule or /loop in Claude Code).
---

# Moodle: proactive digest

Goal: a short, scannable "what changed and what's coming" briefing across all
courses — the things that are easy to miss (announcements buried in forums,
undated pending work, freshly posted grades).

Uses the `moodle-student` MCP tools, plus Read/Write for delta state.

## Steps

1. **Set the window / load state.** If `digest_state.json` exists in the working
   directory, read it (`last_run`, seen forum-discussion dates per course, last grade
   snapshot) and report only **deltas** since then. If it doesn't exist, use a
   **7-day lookback** (the user may override the window).
2. **Announcements.** For each course: `list_forums([course_id])`, take the
   forum with `type == "news"` (the news/announcements forum), then
   `get_forum_discussions(forum_id)`. Report posts whose `created` is within the
   window / not already seen. These often hide real deadlines (dates in text).
3. **Upcoming deadlines.** `get_upcoming_deadlines(days=14)`.
4. **Undated pending work.** For each course, `list_assignments([course_id])`
   and `get_submission_status` on each to find items NOT submitted (status
   `"new"` = draft not sent; `null` = never opened). This catches work with no
   due date that the timeline misses.
5. **New / changed grades.** `get_grades(course_id)` per course; compare against
   the snapshot in state and flag items newly graded or changed.
6. **Present the digest**, grouped and concise:
   - ⏰ **Deadlines** (sort by date; flag <48h or overdue first)
   - 📝 **Not submitted** (drafts / never-submitted)
   - 🆕 **New announcements** (1-line summary + any date found in the text)
   - 📊 **New grades**
   Lead with the most urgent. Keep it a briefing, not a data dump.
7. **Save state.** Write `digest_state.json` with this run's timestamp, the seen
   discussion dates, and the grade snapshot, so the next run shows true deltas.

## Notes
- Reply in the user's language, with absolute dates.
- To automate: if the assistant supports scheduled runs (e.g. `/schedule` or
  `/loop` in Claude Code), suggest one (e.g. weekly, Monday morning). The MCP
  server must be reachable and signed in when it runs; in cloud runs, configure
  `MOODLE_URL` + `MOODLE_TOKEN` as secrets (see the README).
- Don't commit `digest_state.json`; it holds personal data.
- If a tool says the user is not signed in, follow the `moodle-setup` skill.
- If nothing is new, say so in one line — don't pad the report.

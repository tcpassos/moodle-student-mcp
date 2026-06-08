# Moodle Student MCP

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP
client) query **your** Moodle **as a student** — no admin access required. It
uses the official Moodle mobile-app web service (`moodle_mobile_app`) with a
personal token, so it only sees what you already see: your courses, topics,
assignments, deadlines, grades, forums, and downloadable files.

> Works with any Moodle site that has the official mobile app / web services
> enabled, and with any login method — a local password, or SSO via SAML/CAS/
> OAuth (e.g. Google or Microsoft).

## Tools

| Tool | What it does |
|---|---|
| `whoami` | Confirm the token and show who you are |
| `list_courses` | Courses you are enrolled in |
| `get_course_contents(course_id)` | Sections/topics and activities of a course |
| `list_assignments(course_ids?)` | Assignments with due dates |
| `get_submission_status(assign_id)` | Whether you submitted, grade and feedback |
| `get_upcoming_deadlines(days=30)` | Timeline of pending work / deadlines |
| `get_grades(course_id)` | Your grades in a course |
| `list_forums(course_ids?)` | Forums / announcements |
| `get_forum_discussions(forum_id)` | Recent posts in a forum |
| `list_files(course_id)` | Downloadable files in a course |
| `download_files(course_id, fileurls?)` | Download files to `materials/` |

All read-only. Nothing is submitted or modified on Moodle.

## Skills (Claude Code)

Project skills under `.claude/skills/`:

- **`/moodle-tasks`** — prioritized weekly pending work + an execution plan for
  the next deadline (also cross-checks undated assignments and the "Avisos"
  forum for announced dates).
- **`/moodle-materials`** — download a course's PDFs/slides/notebooks and
  analyze them by reading them natively.
- **`/moodle-grades`** — grades across courses, current standing, and what's
  needed to reach a target.
- **`/moodle-digest`** — proactive briefing of what's new and what's coming
  (announcements, deadlines, unsubmitted work, new grades); pairs with
  `/schedule` or `/loop`.
- **`/moodle-study`** — build a study guide (summary, flashcards, practice
  questions) from a topic's materials.

---

## 1. Install

Requires **Python 3.10+**. In the project folder:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1            # optional, recommended
pip install -e ".[browser]"            # [browser] enables automatic token capture
python -m playwright install chromium  # only needed for the --browser flow
```

## 2. Get the token

The server needs a Web Services token for the official mobile-app service.
Pick the method that matches how you log in to Moodle.

### Local-password account

If you sign in to Moodle with a username and password it validates directly:

```powershell
python -m moodle_student_mcp.token_helper --url https://your-moodle-site --username USER --password PASS
```

### SSO account (SAML / CAS / OAuth — e.g. Google or Microsoft)

SSO accounts have no local password, so use the **browser flow** — the same way
the official Moodle app authenticates.

**Automatic (recommended)** — opens a browser and captures the token for you:

```powershell
python -m moodle_student_mcp.token_helper --url https://your-moodle-site --browser
```

A Chromium window opens; log in normally (your institution's login, MFA if any).
The script intercepts the `moodlemobile://token=...` redirect, validates the
token and writes it to `.env`. You'll see `✅ Token OK! Logged in as: <your name>`.

**Manual (no Playwright):**

```powershell
python -m moodle_student_mcp.token_helper --url https://your-moodle-site
```

It prints a `.../admin/tool/mobile/launch.php?...` link. Open it (logged in),
finish the login; the browser then tries to open `moodlemobile://token=...`.
Capture it via `F12 → Network → Preserve log → launch.php → Location`, and paste
it back. (`--paste "moodlemobile://token=..."` skips the prompt.)

> Already have a token (e.g. from Moodle → *Preferences → Security keys*)? Pass
> it directly with `--paste <token>`.

## 3. Connect to Claude

### Claude Code

Create a `.mcp.json` at the project root (copy `.mcp.json.example`) pointing at
your venv's Python with an **absolute** path (on macOS/Linux use
`.venv/bin/python`):

```json
{
  "mcpServers": {
    "moodle-student": {
      "command": "<path-to-project>/.venv/Scripts/python.exe",
      "args": ["-m", "moodle_student_mcp"]
    }
  }
}
```

Reload the VS Code window (or reopen Claude Code) to pick up the server; approve
the project MCP server when prompted. The token is read from `.env`
automatically (resolved by absolute project path, independent of the cwd).

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "moodle-student": {
      "command": "<path-to-project>/.venv/Scripts/python.exe",
      "args": ["-m", "moodle_student_mcp"]
    }
  }
}
```

Then ask things like *"What's due in the next two weeks?"*, *"Summarize the
topics of course X and what I haven't completed"*, *"Do I have any submitted but
not-yet-graded assignments?"*.

---

## Security and limits

- **The token is like a password.** It lives in `.env` (git-ignored). Don't
  commit or share it. To revoke: Moodle → *Preferences → Security keys* → remove
  the mobile app token.
- Read-only, your data only — every call still goes through your account's
  permissions on the server.
- **Acceptable use:** automating access to your university's Moodle, even
  read-only with your own account, may conflict with the institution's IT
  policy. Use modest request volumes and check the rules. Admins can see token
  usage in the web service logs.
- If the token stops working (password/SSO change, expiry, maintenance), just
  redo step 2.

## Troubleshooting

| Error | Likely cause |
|---|---|
| `invalidtoken` on validate | Token mis-pasted / expired — redo step 2 |
| `invalidlogin` in password flow | Account is SSO (no local password) — use the browser flow |
| `servicenotavailable` | The mobile service was disabled by the admin |
| `enablewsdescription` | Web services disabled on the site |
| Tool returns empty | Not enrolled / no data in that course |

## Development

```powershell
.\.venv\Scripts\python.exe -m py_compile moodle_student_mcp\*.py   # syntax check
.\.venv\Scripts\python.exe smoke_test.py                           # exercise tools on real data
```

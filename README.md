# Moodle Student MCP

An [MCP](https://modelcontextprotocol.io) server, packaged as a plugin for
Claude Code, GitHub Copilot CLI, OpenAI Codex and Gemini CLI, that lets your AI
assistant read **your** Moodle **as a student**. It uses Moodle's official
mobile-app web service, so it only sees what you already see: courses, topics,
assignments, deadlines, grades, forums and course files. No admin access needed,
and nothing is ever changed on Moodle.

It works with any Moodle site that allows the official mobile app, and with any
login method: a Moodle password, or SSO (Microsoft, Google, SAML, CAS) with MFA.

Requires **Node.js 22+**.

## Install

Pick your assistant. The plugin installs the MCP server plus the study and
planning [skills](#skills).

| Assistant | Command |
|---|---|
| Claude Code (plugin) | `claude plugin marketplace add tcpassos/moodle-student-mcp`<br>`claude plugin install moodle-student@moodle-student-mcp` |
| Claude Code (server only) | `claude mcp add moodle-student -- npx -y @tcpassos/moodle-student-mcp` |
| GitHub Copilot CLI | `copilot plugin install tcpassos/moodle-student-mcp` |
| OpenAI Codex | `codex plugin marketplace add tcpassos/moodle-student-mcp`, then `/plugins` |
| Gemini CLI | `gemini extensions install https://github.com/tcpassos/moodle-student-mcp` |

Any other MCP client (Claude Desktop, Cursor, VS Code, ...):

```json
{
  "mcpServers": {
    "moodle-student": {
      "command": "npx",
      "args": ["-y", "@tcpassos/moodle-student-mcp"]
    }
  }
}
```

> On native Windows, some clients need `npx` wrapped as
> `"command": "cmd", "args": ["/c", "npx", "-y", "@tcpassos/moodle-student-mcp"]`.

## Sign in

Just ask your assistant something like *"connect to my Moodle"* or *"what's due
this week?"*. When it isn't signed in yet, it calls the `login` tool, asking you
for your Moodle address the first time:

- **On a computer with a browser**, a browser window opens (Chrome, Edge,
  Brave, Chromium or Vivaldi, whichever is installed; nothing is downloaded).
  Sign in as usual, SSO and MFA included. The window closes and you're done.
- **Without a browser** (cloud sandboxes, SSH, containers), the assistant gives
  you a link. Open it on any device (your laptop or phone), sign in to Moodle,
  and paste back the short code it shows (`msmcp1.…`).

Prefer the terminal? Run:

```bash
npx -y @tcpassos/moodle-student-mcp login
```

Your Moodle password and token never pass through the chat: the browser
flow hands the token straight to the server, and the link code is encrypted so
that only your server can open it. The token is kept in your operating system's
credential store (Windows Credential Manager, macOS Keychain, Linux Secret
Service), or in a private file (`0600`) where none is available. It is never
written into your project.

`npx -y @tcpassos/moodle-student-mcp status` shows who is signed in, and
`logout` removes the saved sign-in.

### Cloud, CI and other non-interactive setups

Set environment variables instead of signing in:

| Variables | When |
|---|---|
| `MOODLE_URL` + `MOODLE_TOKEN` (or `MOODLE_TOKEN_FILE`) | Any account. Get the token on a computer where you signed in with `npx -y @tcpassos/moodle-student-mcp token` and store it as a secret. |
| `MOODLE_URL` + `MOODLE_USERNAME` + `MOODLE_PASSWORD` | Accounts with a Moodle password (not SSO). The token is fetched and refreshed automatically. |

Environment credentials take precedence over a saved sign-in.

## Tools

| Tool | What it does |
|---|---|
| `login` | Sign in (browser window, or a link for another device) |
| `auth_status` | Who is signed in, on which site, and where the credential comes from |
| `logout` | Remove the saved sign-in |
| `whoami` | Your name, site, Moodle version and the time zone used for dates |
| `list_courses` | Courses you are enrolled in |
| `get_course_contents(course_id)` | Sections/topics and activities of a course |
| `list_assignments(course_ids?)` | Assignments with due dates |
| `get_submission_status(assign_id)` | Whether you submitted, grade and feedback |
| `get_upcoming_deadlines(days=30)` | Timeline of pending work |
| `get_grades(course_id)` | Your grades in a course |
| `list_forums(course_ids?)` | Forums, including the announcements forum |
| `get_forum_discussions(forum_id, limit=10)` | Recent posts in a forum |
| `list_files(course_id)` | Downloadable files in a course |
| `download_files(course_id, fileurls?)` | Download files and return their local paths |

Dates are ISO 8601 with an explicit offset (e.g. `2026-10-20T23:59:00-03:00`),
in your Moodle profile's time zone.

## Skills

Installed with the plugin (`skills/`, in the shared SKILL.md format):

- **moodle-setup**: connect or fix the Moodle sign-in.
- **moodle-tasks**: prioritized pending work for the week and a plan for the
  next deadline (also catches undated assignments and dates announced in the
  news forum).
- **moodle-materials**: download a course's PDFs, slides and notebooks and
  analyze them.
- **moodle-grades**: grades across courses, current standing, and what's
  needed to reach a target.
- **moodle-digest**: a briefing of what's new and what's coming; pairs with
  scheduled runs.
- **moodle-study**: a study guide (summary, flashcards, practice questions)
  from a topic's materials.

## Configuration

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `MOODLE_URL` | from the saved sign-in | Moodle address |
| `MOODLE_DOWNLOAD_DIR` | `./materials` (or `~/moodle-materials`) | Where `download_files` saves files |
| `MOODLE_TIMEZONE` | your Moodle profile zone | IANA zone for dates |
| `MOODLE_LOGIN_METHOD` | `auto` | `browser` or `link` to force a sign-in method |
| `MOODLE_BROWSER` | auto-detected | Path to a Chromium-based browser for sign-in |
| `MOODLE_CREDENTIAL_STORE` | `auto` | `keychain` or `file` |
| `MOODLE_STUDENT_MCP_HOME` | OS config folder | Where the session and file store live |
| `MOODLE_LOGIN_HELPER_URL` | this project's GitHub Pages | Self-hosted copy of [`docs/login`](docs/login) |

## Security and limits

- **Read-only, your data only.** Every call goes through your own account's
  permissions. `download_files` only fetches files listed in the course, so the
  token is never sent anywhere else.
- **The token is a password.** It never appears in tool results, logs or error
  messages, and `token` refuses to print it unless it's run directly in a
  terminal. To revoke it: Moodle → *Preferences → Security keys*.
- **How link sign-in works.** The server makes a one-time P-256 key pair and
  puts the public key in the link's `#fragment`, which browsers never send to
  any server. The [helper page](docs/login) (static, no backend) sends you to
  Moodle's `launch.php`. Moodle hands the token back to the page, which encrypts
  it (ECDH + HKDF-SHA256 + AES-256-GCM) into the code you paste. Codes expire
  after 15 minutes and work only once.
- **Acceptable use.** Automated access to your university's Moodle, even
  read-only, may fall under its IT policy. Keep request volumes modest. Admins
  can see token usage in the web service logs.

## Troubleshooting

| Problem | Likely cause |
|---|---|
| "Not signed in" | Ask the assistant to sign in, or run `npx -y @tcpassos/moodle-student-mcp login` |
| "does not allow the Moodle mobile app service" | The site admin disabled mobile web services |
| Browser window doesn't open | No Chromium-based browser found: set `MOODLE_BROWSER`, or use `MOODLE_LOGIN_METHOD=link` |
| Link page shows no code | Allow the "web+moodlestudent" prompt, or copy the "launch the app" link on the Moodle page into the sign-in page |
| "Moodle rejected the username/password" | The account uses SSO and has no Moodle password: use `login` instead |
| A tool returns an empty list | Not enrolled, or no data in that course |

## Development

```bash
npm install
npm test              # unit tests
npm run typecheck
npm run build
node --env-file=.env scripts/smoke.mjs   # exercise every tool against a real Moodle
```

The helper page in `docs/login/` is plain static HTML/JS served by GitHub Pages
(*Settings → Pages → Deploy from branch → `main` / `docs`*). Its crypto
lives in `docs/login/login.js` and is covered by the Node tests.

Release checklist: bump the version in `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `plugin.json`, `gemini-extension.json` and the
`npx` version range in the manifests, then `npm publish --access public`.

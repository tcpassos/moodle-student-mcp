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

## Two ways to use it

| | On your computer | In the cloud |
|---|---|---|
| Where the assistant runs | Claude Code, Claude Desktop, Copilot CLI, Codex, Gemini CLI, Cursor, ... on your machine | Claude Code on the web, CI, remote servers, containers |
| Install | The plugin (or the MCP server) | A `.mcp.json` in the repository, or the environment's MCP config |
| Sign in | A browser window opens; sign in as usual | Sign in once on your computer and pass the token as a secret |

## Use it on your computer

### 1. Install

Pick your assistant. The plugin brings the MCP server plus the study and
planning [skills](#skills).

| Assistant | Command |
|---|---|
| Claude Code (plugin) | `claude plugin marketplace add tcpassos/moodle-student-mcp`<br>`claude plugin install moodle-student@moodle-student-mcp`<br>(or `/plugin marketplace add …` and `/plugin install …` inside a session) |
| Claude Code (server only) | `claude mcp add moodle-student -- npx -y @tcpassos/moodle-student-mcp` |
| GitHub Copilot CLI | `copilot plugin marketplace add tcpassos/moodle-student-mcp`<br>`copilot plugin install moodle-student@moodle-student-mcp` |
| OpenAI Codex | `codex plugin marketplace add tcpassos/moodle-student-mcp`<br>`codex plugin add moodle-student@moodle-student-mcp`<br>(or `/plugins` inside a session) |
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

> If a client on native Windows cannot start `npx`, use
> `"command": "cmd", "args": ["/c", "npx", "-y", "@tcpassos/moodle-student-mcp"]`.
> Claude Code runs plain `npx` fine.

### 2. Sign in

Ask your assistant something like *"connect to my Moodle"* or *"what's due this
week?"*. The first time, it asks for your Moodle address and calls the `login`
tool, which opens a browser window (Chrome, Edge, Brave, Chromium or Vivaldi,
whichever is installed; nothing is downloaded). Sign in as usual, SSO and MFA
included. The window closes and you're done.

Prefer the terminal? Run `npx -y @tcpassos/moodle-student-mcp login`.

Your Moodle password and token never pass through the chat. The token is kept
in your operating system's credential store (Windows Credential Manager, macOS
Keychain, Linux Secret Service), or in a private file (`0600`) where none is
available. It is never written into your project.
`npx -y @tcpassos/moodle-student-mcp status` shows who is signed in, and
`logout` removes the saved sign-in.

## Use it in the cloud

Signing in needs a browser this program controls, because Moodle only hands
its token to the mobile app's `moodlemobile://` links. So remote environments
are *configured* instead: you sign in once on your own computer and give the
environment the token as a secret.

### 1. Get the token on your computer

```bash
npx -y @tcpassos/moodle-student-mcp login
npx -y @tcpassos/moodle-student-mcp token
```

`token` copies two lines to the clipboard, `MOODLE_URL=…` and `MOODLE_TOKEN=…`,
without showing the token (`--print` shows it, in a terminal only).

Moodle tokens last **12 weeks** by default (each site may change this). When the
tools report an expired sign-in, run these two commands again and update the
secret.

### 2a. Claude Code on the web

Cloud sessions don't load your local MCP servers or plugins; they load the
`.mcp.json` committed in the repository the session works on. One-time setup:

1. In that repository, commit this `.mcp.json`. It also works on your
   computer: when the variables are not set they expand to nothing (`:-`), and
   the server uses your saved sign-in.

   ```json
   {
     "mcpServers": {
       "moodle-student": {
         "command": "npx",
         "args": ["-y", "@tcpassos/moodle-student-mcp"],
         "env": {
           "MOODLE_URL": "${MOODLE_URL:-}",
           "MOODLE_TOKEN": "${MOODLE_TOKEN:-}"
         }
       }
     }
   }
   ```

2. At [claude.ai/code](https://claude.ai/code), edit the environment you use:
   - **Environment variables**: paste the two lines from `token`.
   - **Network access**: choose **Custom**, add your Moodle host (e.g.
     `www.moodle.unisinos.br`) and keep **Also include default list of common
     package managers** checked, so `npx` can download the server.
3. Start a new session and ask about your Moodle. New values reach a session
   when it is created.

To also get the [skills](#skills) there, copy the `skills/` folders into the
repository's `.claude/skills/`. Environment variables are readable by anything
running in the session, Claude included, so keep the environment personal and
don't ask Claude to print them.

### 2b. Other cloud, CI and remote setups

Run the server with `npx -y @tcpassos/moodle-student-mcp` and set these
environment variables (as secrets); they take precedence over a saved sign-in:

| Variables | When |
|---|---|
| `MOODLE_URL` + `MOODLE_TOKEN` (or `MOODLE_TOKEN_FILE`) | Any account, including SSO |
| `MOODLE_URL` + `MOODLE_USERNAME` + `MOODLE_PASSWORD` | Accounts with a Moodle password (not SSO); the token is fetched and refreshed automatically |

If the environment restricts outbound traffic, allow your Moodle host (and the
npm registry, for `npx`).

## Tools

| Tool | What it does |
|---|---|
| `login` | Sign in through a browser window (explains the cloud setup where there is no screen) |
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
| `MOODLE_BROWSER` | auto-detected | Path to a Chromium-based browser for sign-in |
| `MOODLE_CREDENTIAL_STORE` | `auto` | `keychain` or `file` |
| `MOODLE_STUDENT_MCP_HOME` | `%USERPROFILE%\.moodle-student-mcp` (Windows), `~/Library/Application Support/moodle-student-mcp` (macOS), `~/.config/moodle-student-mcp` (Linux) | Where the session and file store live |

On Windows the folder is outside AppData on purpose: Claude Desktop is a
packaged (MSIX) app, and files its processes create under AppData go to a
private copy that terminals and other assistants don't see.

## Security and limits

- **Read-only, your data only.** Every call goes through your own account's
  permissions. `download_files` only fetches files listed in the course, so the
  token is never sent anywhere else.
- **The token is a password.** It never appears in tool results, logs or error
  messages. `token` copies it to the clipboard and only prints it with
  `--print` in a real terminal. To revoke it: Moodle → *Preferences → Security
  keys*.
- **How sign-in works.** The server opens Moodle's mobile-app sign-in page
  (`admin/tool/mobile/launch.php`) in a throwaway browser profile, reads the
  token from Moodle's answer over the DevTools protocol, checks that it is
  signed for this site and this attempt (`md5(wwwroot + passport)`) and closes
  the browser. Moodle only hands this token to its app's `moodlemobile://`
  links, which no web page can receive, so signing in needs a browser this
  program controls: there is no "open a link on your phone" sign-in.
- **Acceptable use.** Automated access to your university's Moodle, even
  read-only, may fall under its IT policy. Keep request volumes modest. Admins
  can see token usage in the web service logs.

## Troubleshooting

| Problem | Likely cause |
|---|---|
| "Not signed in" | Ask the assistant to sign in, or run `npx -y @tcpassos/moodle-student-mcp login` |
| Windows: signed in through Claude Desktop, but a terminal or another assistant says "Not signed in" | Versions before 0.2.1 kept the sign-in under AppData, where Claude Desktop's copy is private to it. 0.2.1 and later use `%USERPROFILE%\.moodle-student-mcp` and pick up the old sign-in by themselves: check with `npx -y @tcpassos/moodle-student-mcp@latest status` |
| "Found the saved Moodle sign-in … but could not read its token" | The session is saved, but its token is gone from the OS credential store (removed, or saved by another user account) or its token file is missing: sign in again. Where no credential store works, set `MOODLE_CREDENTIAL_STORE=file` before signing in |
| "does not allow the Moodle mobile app service" | The site admin disabled mobile web services |
| "This environment has no screen" | Cloud sandbox, SSH or container: see [Use it in the cloud](#use-it-in-the-cloud) |
| Browser window doesn't open | No Chromium-based browser found: install Chrome or Edge, or set `MOODLE_BROWSER` |
| Worked for weeks, now "expired" | Moodle tokens last 12 weeks by default: sign in again (and run `token` again for cloud secrets) |
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

Release checklist: bump the version in `package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `plugin.json`, `gemini-extension.json` and the
`npx` version range in the manifests, then `npm publish --access public`.

The plugin manifests start the server as
`npx -y moodle-student-mcp@npm:@tcpassos/moodle-student-mcp@^x.y.z`. Hosts
start plugin servers inside the plugin folder, whose `package.json` has the
same name, and a plain `npx -y @tcpassos/moodle-student-mcp` there resolves to
that unbuilt local copy instead of the published package.

## License

[MIT](LICENSE)

---
name: moodle-setup
description: Connect the assistant to the user's Moodle account, or fix the connection. Use when the user wants to connect, sign in to, or switch their Moodle account, when a Moodle tool says the user is not signed in, or when Moodle tools fail with an expired or invalid sign-in.
---

# Moodle: sign in

Goal: get the `moodle-student` MCP server signed in to the user's Moodle
without any password or token passing through the chat.

## Steps

1. **Check the current state.** Call `auth_status`. If `signed_in` is true and
   it is the right person and site, you are done; tell the user who is signed in.
2. **Know the site.** If no Moodle address is configured, ask the user for the
   address of their Moodle (for example `https://moodle.example.edu`). The home
   page they open in the browser is fine; the server finds the site from it.
3. **Start the sign-in.** Call `login` with `site_url` (omit it if the site is
   already known). Then:
   - `signed_in` — done. Confirm with the name it reports.
   - `waiting_for_browser` — a browser window opened on the user's computer.
     Ask them to sign in there as usual (SSO, Microsoft/Google, MFA all work),
     then call `login` again with no arguments to keep waiting.
   - An error saying this environment has no screen (cloud sandbox, SSH,
     container) — sign-in has to happen on the user's own computer. Relay the
     steps from the error: on a computer with a browser, run
     `npx -y @tcpassos/moodle-student-mcp login`, then
     `npx -y @tcpassos/moodle-student-mcp token` (it copies `MOODLE_URL` and
     `MOODLE_TOKEN` to the clipboard), and paste those into this environment's
     environment variables / secrets settings. A new session picks them up.
4. **Verify.** Call `whoami` and tell the user who they are signed in as.

## Rules

- Never ask the user to type their Moodle password or token into the chat, and
  never put either in a tool argument, file or command. If they paste one
  anyway, don't use it; tell them it belongs in the environment settings and
  suggest revoking it later in Moodle (Preferences > Security keys) if the chat
  is shared.
- Tokens usually expire after 12 weeks. When Moodle tools report an expired
  sign-in in a cloud environment, the user repeats `login` + `token` on their
  computer and updates the secret.
- To switch accounts, call `logout` and then `login`.
- Accounts with a Moodle password (not SSO) can use `MOODLE_URL`,
  `MOODLE_USERNAME` and `MOODLE_PASSWORD` instead; point the user to the
  README, don't ask for the values.

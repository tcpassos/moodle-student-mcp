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
   already known). Then follow the `status` it returns:
   - `signed_in` — done. Confirm with the name it reports.
   - `waiting_for_browser` — a browser window opened on the user's computer.
     Ask them to sign in there as usual (SSO, Microsoft/Google, MFA all work),
     then call `login` again with no arguments to keep waiting.
   - `link` — this machine cannot show a browser (cloud sandbox, SSH, container).
     Give the user the `url`, and ask them to open it on any device, sign in to
     Moodle, and paste back the code the page shows (it starts with `msmcp1.`).
     Then call `login` with `code` set to what they pasted.
4. **Verify.** Call `whoami` and tell the user who they are signed in as.

## Rules

- Never ask the user to type their Moodle password or token into the chat, and
  never put either in a tool argument, file or command. The `msmcp1.` code is
  encrypted for this server only, so relaying it is fine.
- If the link page says the code did not appear automatically, the page itself
  explains the fallback (copy the "launch the app" link on the Moodle page and
  paste it into the sign-in page, not into the chat).
- To switch accounts, call `logout` and then `login`.
- Environments without any browser can also be configured with environment
  variables (`MOODLE_URL` plus `MOODLE_TOKEN`, or `MOODLE_USERNAME` and
  `MOODLE_PASSWORD` for accounts with a Moodle password). Point the user to the
  project README for that; don't ask for the values.

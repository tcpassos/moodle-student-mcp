#!/usr/bin/env node
/**
 * Command line entry point. With no command it runs the MCP server over
 * stdio; the other commands manage the Moodle sign-in from a terminal.
 */

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { APP_NAME, VERSION, configDir } from "./config.js";
import { resolveCredential } from "./auth/credentials.js";
import { login, type LoginMethod } from "./auth/login.js";
import { clearPendingLogin } from "./auth/relay.js";
import { clearCredential, loadSession } from "./auth/store.js";
import { MoodleClient } from "./moodle/client.js";
import { createServer } from "./server.js";

const HELP = `${APP_NAME} ${VERSION}

Usage:
  ${APP_NAME}                 Run the MCP server over stdio (what MCP clients start)
  ${APP_NAME} login [--url <moodle-address>] [--method auto|browser|link]
                              Sign in (opens a browser, or prints a link for another device)
  ${APP_NAME} status          Show who is signed in and where the credential comes from
  ${APP_NAME} logout          Remove the saved sign-in from this computer
  ${APP_NAME} token           Print the saved token (terminal only), e.g. to set MOODLE_TOKEN elsewhere
  ${APP_NAME} --version

Environment (optional):
  MOODLE_URL                  Moodle address
  MOODLE_TOKEN | MOODLE_TOKEN_FILE   Use this token instead of a saved sign-in (cloud/CI)
  MOODLE_USERNAME + MOODLE_PASSWORD  Accounts with a Moodle password, no browser needed
  MOODLE_DOWNLOAD_DIR         Where download_files saves materials (default ./materials)
  MOODLE_TIMEZONE             IANA zone for dates (default: your Moodle profile zone)
  MOODLE_CREDENTIAL_STORE     auto | keychain | file
  MOODLE_STUDENT_MCP_HOME     Config folder (default ${configDir()})
`;

function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function serve(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

async function loginCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { url: { type: "string" }, method: { type: "string" } },
  });
  const method = values.method as LoginMethod | undefined;
  if (method && !["auto", "browser", "link"].includes(method)) throw new Error(`Unknown method: ${method}`);

  let siteUrl = values.url;
  if (!siteUrl && !process.env.MOODLE_URL && !(await loadSession())) {
    siteUrl = await ask("Moodle address (e.g. https://moodle.example.edu): ");
  }

  let result = await login({ siteUrl, method, waitMs: 10 * 60_000 });
  if (result.status === "link") {
    say("\nOpen this link on any device with a browser and sign in to Moodle:\n");
    say(`  ${result.url}\n`);
    say(`It shows a code starting with msmcp1. (valid until ${new Date(result.expiresAt).toLocaleTimeString()}).`);
    const code = await ask("Paste the code here: ");
    result = await login({ code });
  } else if (result.status === "waiting_for_browser") {
    say("A browser window opened. Sign in there...");
    result = await login({ waitMs: 10 * 60_000 });
  }
  if (result.status !== "signed_in") throw new Error("The sign-in did not finish in time. Run login again.");
  const { session } = result;
  say(`\nSigned in as ${session.fullName} (${session.username}) on ${session.siteName ?? session.siteUrl}.`);
  say(`Token saved in the ${session.store === "keychain" ? "OS credential store" : `file store under ${configDir()}`}.`);
}

async function statusCommand(): Promise<void> {
  const credential = await resolveCredential();
  if (!credential) {
    say(`Not signed in. Run: ${APP_NAME} login`);
    process.exitCode = 1;
    return;
  }
  const info = await new MoodleClient(credential.siteUrl, credential.token).call<Record<string, any>>(
    "core_webservice_get_site_info",
  );
  say(`Signed in as ${info.fullname} (${info.username}) on ${info.sitename} — ${credential.siteUrl}`);
  say(`Credential source: ${credential.source}`);
}

async function tokenCommand(): Promise<void> {
  if (!process.stdout.isTTY) {
    throw new Error(
      "Refusing to print the token to a pipe or file. Run this command directly in a terminal; " +
        "this keeps the token away from scripts and AI agents that capture command output.",
    );
  }
  const credential = await resolveCredential();
  if (!credential) throw new Error(`Not signed in. Run: ${APP_NAME} login`);
  say(`Token for ${credential.siteUrl} (${credential.source}). Use it as MOODLE_TOKEN with MOODLE_URL=${credential.siteUrl}:`);
  process.stdout.write(`${credential.token}\n`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "serve":
      return serve();
    case "login":
      return loginCommand(rest);
    case "status":
      return statusCommand();
    case "logout": {
      const removed = await clearCredential();
      await clearPendingLogin();
      say(removed ? "Signed out: the saved sign-in was removed." : "There was no saved sign-in.");
      return;
    }
    case "token":
      return tokenCommand();
    case "-v":
    case "--version":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      say(`Unknown command: ${command}\n`);
      process.stdout.write(HELP);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  say(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

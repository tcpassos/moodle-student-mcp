#!/usr/bin/env node
/**
 * Command line entry point. With no command it runs the MCP server over
 * stdio; the other commands manage the Moodle sign-in from a terminal.
 */

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { APP_NAME, VERSION, configDir } from "./config.js";
import { NotSignedInError, resolveCredential, type ActiveCredential } from "./auth/credentials.js";
import { login } from "./auth/login.js";
import { clearCredential, loadSession } from "./auth/store.js";
import { copyToClipboard } from "./clipboard.js";
import { MoodleClient } from "./moodle/client.js";
import { createServer } from "./server.js";

const HELP = `${APP_NAME} ${VERSION}

Usage:
  ${APP_NAME}                 Run the MCP server over stdio (what MCP clients start)
  ${APP_NAME} login [--url <moodle-address>]
                              Sign in through a browser window (SSO and MFA work)
  ${APP_NAME} status          Show who is signed in and where the credential comes from
  ${APP_NAME} logout          Remove the saved sign-in from this computer
  ${APP_NAME} token [--print] Copy MOODLE_URL and MOODLE_TOKEN to the clipboard, to configure
                              a cloud or CI environment (--print shows them; terminal only)
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
  const { values } = parseArgs({ args, options: { url: { type: "string" } } });

  let siteUrl = values.url;
  if (!siteUrl && !process.env.MOODLE_URL && !(await loadSession())) {
    siteUrl = await ask("Moodle address (e.g. https://moodle.example.edu): ");
  }

  say("A browser window is opening. Sign in to Moodle there...");
  let result = await login({ siteUrl, waitMs: 10 * 60_000 });
  if (result.status === "waiting_for_browser") result = await login({ waitMs: 10 * 60_000 });
  if (result.status !== "signed_in") throw new Error("The sign-in did not finish in time. Run login again.");
  const { session } = result;
  say(`\nSigned in as ${session.fullName} (${session.username}) on ${session.siteName ?? session.siteUrl}.`);
  say(`Token saved in the ${session.store === "keychain" ? "OS credential store" : `file store under ${configDir()}`}.`);
}

/** The credential in use, or why there is none, worded for the terminal. */
async function activeCredential(): Promise<ActiveCredential | string> {
  try {
    return (await resolveCredential()) ?? `Not signed in. Run: ${APP_NAME} login`;
  } catch (error) {
    if (error instanceof NotSignedInError) return `${error.reason} Run: ${APP_NAME} login`;
    throw error;
  }
}

async function statusCommand(): Promise<void> {
  const credential = await activeCredential();
  if (typeof credential === "string") {
    say(credential);
    process.exitCode = 1;
    return;
  }
  const info = await new MoodleClient(credential.siteUrl, credential.token).call<Record<string, any>>(
    "core_webservice_get_site_info",
  );
  say(`Signed in as ${info.fullname} (${info.username}) on ${info.sitename} — ${credential.siteUrl}`);
  say(`Credential source: ${credential.source}${credential.savedIn ? ` (${credential.savedIn})` : ""}`);
}

async function tokenCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { print: { type: "boolean" } } });
  const credential = await activeCredential();
  if (typeof credential === "string") throw new Error(credential);
  const lines = `MOODLE_URL=${credential.siteUrl}\nMOODLE_TOKEN=${credential.token}\n`;

  if (values.print) {
    if (!process.stdout.isTTY) {
      throw new Error(
        "Refusing to print the token to a pipe or file. Run this command directly in a terminal, or drop " +
          "--print to copy it to the clipboard; this keeps the token away from scripts and AI agents.",
      );
    }
    process.stdout.write(lines);
  } else if (await copyToClipboard(lines)) {
    say("Copied to the clipboard:\n");
    say(`  MOODLE_URL=${credential.siteUrl}`);
    say("  MOODLE_TOKEN=******** (hidden)\n");
  } else {
    throw new Error("No clipboard is available here. Run it in a terminal with --print instead.");
  }
  const host = new URL(credential.siteUrl).host;
  say(
    "Paste these into the environment variables / secrets of the cloud or CI environment, and make sure it " +
      `may reach ${host}. In Claude Code on the web: environment settings > Environment variables, and ` +
      `Network access > Custom with ${host} added (keep the default package list for npm).\n` +
      "Moodle tokens usually expire after 12 weeks; then run login and token again and update the secret.",
  );
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
      say(removed ? "Signed out: the saved sign-in was removed." : "There was no saved sign-in.");
      return;
    }
    case "token":
      return tokenCommand(rest);
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

/** Copy text to the system clipboard with the platform's own tool. */

import { spawn } from "node:child_process";

const COMMANDS: Record<string, string[][]> = {
  win32: [["clip"]],
  darwin: [["pbcopy"]],
};
const UNIX_COMMANDS = [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];

function run(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}

/** Returns false when no clipboard tool is available (e.g. a headless server). */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const [command, ...args] of COMMANDS[process.platform] ?? UNIX_COMMANDS) {
    if (await run(command!, args, text)) return true;
  }
  return false;
}

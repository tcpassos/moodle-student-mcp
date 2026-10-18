/**
 * Browser login: opens a Chromium-based browser that is already installed
 * (Chrome, Edge, Brave, Chromium, Vivaldi) with a throwaway profile, lets the
 * user sign in normally (SSO, MFA, password) and reads the token from
 * launch.php's response over the DevTools protocol. No browser download, no
 * extra dependency (Node's built-in WebSocket speaks CDP).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { env } from "../config.js";
import { extractPayload, type LaunchPayload } from "./launch.js";

/** Path of an installed Chromium-based browser, or null. MOODLE_BROWSER overrides. */
export function findBrowser(): string | null {
  const override = env("MOODLE_BROWSER");
  if (override) return existsSync(override) ? override : null;

  const candidates: string[] = [];
  if (process.platform === "win32") {
    const roots = [env("ProgramFiles"), env("ProgramFiles(x86)"), env("LOCALAPPDATA")].filter((r): r is string => !!r);
    const relative = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "Chromium\\Application\\chrome.exe",
      "Vivaldi\\Application\\vivaldi.exe",
    ];
    for (const rel of relative) for (const root of roots) candidates.push(join(root, rel));
  } else if (process.platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Brave Browser.app/Contents/MacOS/Brave Browser",
      "Chromium.app/Contents/MacOS/Chromium",
      "Vivaldi.app/Contents/MacOS/Vivaldi",
    ];
    for (const app of apps) for (const base of ["/Applications", join(homedir(), "Applications")]) candidates.push(join(base, app));
  } else {
    const names = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
      "microsoft-edge-stable",
      "brave-browser",
      "vivaldi",
    ];
    const dirs = (env("PATH") ?? "").split(delimiter).filter(Boolean);
    for (const name of names) for (const dir of dirs) candidates.push(join(dir, name));
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Whether a browser window opened here would be seen by the user. */
export function canShowBrowserWindow(): boolean {
  if (env("CI")) return false;
  const overSsh = Boolean(env("SSH_CONNECTION") || env("SSH_CLIENT") || env("SSH_TTY"));
  if (process.platform === "win32" || process.platform === "darwin") return !overSsh;
  return Boolean(env("DISPLAY") || env("WAYLAND_DISPLAY"));
}

const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7f9;color:#1f2328}
main{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.4rem}</style></head>
<body><main><h1>Signed in to Moodle</h1><p>You can close this window and go back to your assistant.</p></main></body></html>`;

type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

class CdpConnection {
  readonly #socket: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  onEvent: (message: CdpMessage) => void = () => {};
  onClose: () => void = () => {};

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
      } else {
        this.onEvent(message);
      }
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.#pending.values()) waiter.reject(new Error("DevTools connection closed"));
      this.#pending.clear();
      this.onClose();
    });
  }

  static open(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new CdpConnection(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to the browser")), { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      // Already closed.
    }
  }
}

async function waitForDevTools(profileDir: string, exited: () => boolean, stderr: () => string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const fromStderr = /DevTools listening on (ws:\/\/\S+)/.exec(stderr());
    if (fromStderr) return fromStderr[1]!;
    try {
      const [port, path] = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8")).split(/\r?\n/);
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {
      // Not written yet.
    }
    if (exited()) throw new Error("The browser exited before it could be controlled.");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for the browser to start.");
}

export interface BrowserLoginOptions {
  timeoutMs?: number;
  browserPath?: string;
}

/** Open `launchUrl` in a fresh browser window and resolve with the token payload. */
export async function browserLogin(launchUrl: string, options: BrowserLoginOptions = {}): Promise<LaunchPayload> {
  const executable = options.browserPath ?? findBrowser();
  if (!executable) throw new Error("No Chrome, Edge, Brave, Chromium or Vivaldi installation was found.");

  const profileDir = await mkdtemp(join(tmpdir(), "moodle-student-login-"));
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--new-window",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  let exited = false;
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < 64_000) stderr += chunk;
  });
  child.on("error", () => {
    exited = true;
  });

  let cdp: CdpConnection | null = null;
  const cleanup = async () => {
    if (cdp) {
      await Promise.race([cdp.send("Browser.close").catch(() => {}), new Promise((r) => setTimeout(r, 2_000))]);
      cdp.close();
    }
    if (!exited) {
      await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 3_000))]);
      if (!exited) child.kill();
    }
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
  };

  try {
    const result = await new Promise<LaunchPayload>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error("Timed out waiting for the Moodle sign-in."))),
        options.timeoutMs ?? 5 * 60_000,
      );
      child.on("exit", () => {
        exited = true;
        settle(() => reject(new Error("The browser window was closed before the sign-in finished.")));
      });

      (async () => {
        const wsUrl = await waitForDevTools(profileDir, () => exited, () => stderr);
        const connection = await CdpConnection.open(wsUrl);
        cdp = connection;
        const pages = new Set<string>();
        const sessions = new Map<string, Promise<string>>();

        // Intercept launch.php responses in every tab, including SSO popups.
        const attach = (targetId: string): Promise<string> => {
          let session = sessions.get(targetId);
          if (!session) {
            session = (async () => {
              const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
              await connection.send(
                "Fetch.enable",
                { patterns: [{ urlPattern: "*admin/tool/mobile/launch.php*", requestStage: "Response" }] },
                sessionId,
              );
              return sessionId as string;
            })();
            sessions.set(targetId, session);
          }
          return session;
        };

        const onPaused = async (params: any, sessionId: string | undefined) => {
          const { requestId, responseStatusCode, responseHeaders = [] } = params;
          let payload: LaunchPayload | null = null;
          if (responseStatusCode >= 300 && responseStatusCode < 400) {
            const location = responseHeaders.find((h: any) => h.name.toLowerCase() === "location")?.value;
            payload = location ? extractPayload(location) : null;
          } else if (responseStatusCode === 200) {
            const body = await connection.send("Fetch.getResponseBody", { requestId }, sessionId);
            const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
            payload = extractPayload(text);
          }
          if (!payload) {
            await connection.send("Fetch.continueRequest", { requestId }, sessionId);
            return;
          }
          await connection.send(
            "Fetch.fulfillRequest",
            {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
              body: Buffer.from(SUCCESS_PAGE).toString("base64"),
            },
            sessionId,
          );
          const found = payload;
          setTimeout(() => settle(() => resolve(found)), 1_500);
        };

        connection.onEvent = (message) => {
          const info = message.params?.targetInfo;
          if (message.method === "Target.targetCreated" && info?.type === "page") {
            pages.add(info.targetId);
            attach(info.targetId).catch(() => {});
          } else if (message.method === "Target.targetDestroyed") {
            pages.delete(message.params.targetId);
            // macOS keeps the app alive with no windows; treat that as closed.
            if (pages.size === 0) {
              settle(() => reject(new Error("The browser window was closed before the sign-in finished.")));
            }
          } else if (message.method === "Fetch.requestPaused") {
            onPaused(message.params, message.sessionId).catch(() => {});
          }
        };
        connection.onClose = () => {
          settle(() => reject(new Error("The browser window was closed before the sign-in finished.")));
        };

        await connection.send("Target.setDiscoverTargets", { discover: true });
        const { targetInfos } = await connection.send("Target.getTargets");
        let page = (targetInfos as any[]).find((t) => t.type === "page");
        if (!page) {
          const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
          page = { targetId };
        }
        pages.add(page.targetId);
        await connection.send("Page.navigate", { url: launchUrl }, await attach(page.targetId));
      })().catch((error) => settle(() => reject(error)));
    });
    return result;
  } finally {
    await cleanup();
  }
}

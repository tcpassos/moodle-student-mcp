/**
 * Runtime configuration: environment variables, the per-user config folder and
 * where downloaded materials go.
 */

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

export const APP_NAME = "moodle-student-mcp";

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version);
  } catch {
    return "0.0.0";
  }
})();

/**
 * Read an environment variable, treating empty values and unexpanded
 * placeholders (e.g. a literal `${user_config.moodle_url}` left by a plugin
 * host that does not expand variables) as unset.
 */
export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value || /^\$\{[^}]*\}$/.test(value)) return undefined;
  return value;
}

/**
 * Folder holding the saved session and the file-based credential store.
 *
 * On Windows it is `%USERPROFILE%\.moodle-student-mcp`, not AppData: packaged
 * (MSIX) apps such as Claude Desktop redirect the files their processes create
 * under AppData to a private per-app copy that no other program sees, while
 * the rest of the user profile is written for real.
 */
export function configDir(): string {
  const override = env("MOODLE_STUDENT_MCP_HOME");
  if (override) return resolve(override);
  if (process.platform === "win32") return join(env("USERPROFILE") ?? homedir(), `.${APP_NAME}`);
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", APP_NAME);
  }
  return join(env("XDG_CONFIG_HOME") ?? join(home, ".config"), APP_NAME);
}

/**
 * Where versions before 0.2.1 kept the config folder on Windows, and so may
 * still hold a sign-in: `%APPDATA%\moodle-student-mcp`, plus the private
 * copies packaged apps made of it
 * (`%LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\moodle-student-mcp`).
 * Empty elsewhere and when MOODLE_STUDENT_MCP_HOME is set.
 */
export async function legacyConfigDirs(): Promise<string[]> {
  if (process.platform !== "win32" || env("MOODLE_STUDENT_MCP_HOME")) return [];
  const home = env("USERPROFILE") ?? homedir();
  const packages = join(env("LOCALAPPDATA") ?? join(home, "AppData", "Local"), "Packages");
  const packageNames = await readdir(packages).catch(() => [] as string[]);
  return [
    join(env("APPDATA") ?? join(home, "AppData", "Roaming"), APP_NAME),
    ...packageNames.map((name) => join(packages, name, "LocalCache", "Roaming", APP_NAME)),
  ];
}

/**
 * Where download_files saves materials. MOODLE_DOWNLOAD_DIR wins; otherwise
 * `<cwd>/materials`, unless the client started us somewhere unsuitable (the
 * filesystem root or a system folder), in which case `~/moodle-materials`.
 */
export function downloadDir(): string {
  const override = env("MOODLE_DOWNLOAD_DIR");
  if (override) return resolve(override);
  const cwd = process.cwd();
  if (isUnsuitableWorkingDir(cwd)) return join(homedir(), "moodle-materials");
  return join(cwd, "materials");
}

function isUnsuitableWorkingDir(dir: string): boolean {
  const normalized = resolve(dir).toLowerCase();
  if (normalized === parse(normalized).root.toLowerCase()) return true;
  if (process.platform === "win32") {
    const systemDirs = [env("SystemRoot"), env("ProgramFiles"), env("ProgramFiles(x86)")]
      .filter((d): d is string => Boolean(d))
      .map((d) => resolve(d).toLowerCase());
    return systemDirs.some((d) => normalized === d || normalized.startsWith(d + "\\"));
  }
  return ["/usr", "/bin", "/sbin", "/etc", "/System", "/Applications"].some(
    (d) => normalized === d.toLowerCase() || normalized.startsWith(d.toLowerCase() + "/"),
  );
}

/**
 * Normalize what a user typed as their Moodle address into an origin + path
 * without trailing slash, query or fragment. Adds https:// when missing.
 */
export function normalizeSiteUrl(input: string): string {
  let text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  let path = url.pathname.replace(/\/webservice\/rest\/server\.php$/i, "");
  path = path.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

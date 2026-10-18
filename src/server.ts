/**
 * MCP server exposing student-level Moodle tools plus sign-in management.
 * Every Moodle tool is read-only on the Moodle side; download_files only
 * writes local copies of course files.
 */

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import { APP_NAME, VERSION } from "./config.js";
import { NotSignedInError } from "./auth/credentials.js";
import { browserAttemptState, login, SiteUrlRequiredError, type LoginResult } from "./auth/login.js";
import { clearPendingLogin, loadPendingLogin } from "./auth/relay.js";
import { MoodleSession } from "./auth/session.js";
import { clearCredential } from "./auth/store.js";
import { MoodleError } from "./moodle/client.js";
import * as tools from "./moodle/tools.js";

const INSTRUCTIONS = `Read-only access to the user's Moodle as a student: courses, contents, assignments, \
submission status, deadlines, grades, forums/announcements and course files.
If a tool says the user is not signed in, call \`login\`. It signs the user in without any password or token \
passing through the chat. Never ask the user to type their Moodle password or token.`;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function failure(error: unknown): CallToolResult {
  let text: string;
  if (error instanceof NotSignedInError || error instanceof SiteUrlRequiredError) text = error.message;
  else if (error instanceof MoodleError) text = `Moodle returned an error: ${error.message}`;
  else text = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text }], isError: true };
}

function describeLogin(result: LoginResult) {
  switch (result.status) {
    case "signed_in":
      return {
        status: "signed_in",
        user: result.session.fullName,
        username: result.session.username,
        site: result.session.siteName ?? result.session.siteUrl,
        site_url: result.session.siteUrl,
        message: `Signed in to Moodle as ${result.session.fullName}. You can use the Moodle tools now.`,
      };
    case "waiting_for_browser":
      return {
        status: "waiting_for_browser",
        site_url: result.site,
        message:
          "A browser window is open on this computer for the user to sign in to Moodle. Ask them to finish " +
          "signing in there, then call login again with no arguments to keep waiting (or auth_status to check).",
      };
    case "link":
      return {
        status: "link",
        site_url: result.site,
        url: result.url,
        expires_at: result.expiresAt,
        message:
          "No browser can be opened here. Give the user this link and ask them to open it on any device with " +
          "a browser, sign in to Moodle, and paste back the code it shows (it starts with msmcp1.). Then call " +
          "login with `code` set to that code. The code is encrypted for this server only; it is not a password " +
          "or a token.",
      };
  }
}

export function createServer(session = new MoodleSession()): McpServer {
  const server = new McpServer({ name: APP_NAME, version: VERSION }, { instructions: INSTRUCTIONS });

  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    annotations: Record<string, boolean>,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ) => {
    server.registerTool(name, { description, inputSchema: z.object(shape), annotations }, (async (args: any) => {
      try {
        return json(await handler(args));
      } catch (error) {
        return failure(error);
      }
    }) as any);
  };

  // ------------------------------------------------------------------ auth

  tool(
    "login",
    "Sign the user in to Moodle. Call it when another Moodle tool says the user is not signed in, or when the " +
      "user wants to connect or switch accounts. Pass `site_url` the first time (ask the user for their Moodle " +
      "address if you don't know it). If a browser can be shown on this computer, a window opens, the user signs " +
      "in there (SSO and MFA work) and this call waits for it. Otherwise it returns a link for the user to open " +
      "on any device; they get a code starting with `msmcp1.` that you pass back as `code`. The code is encrypted " +
      "for this server, so it is safe to relay. Never ask for the user's Moodle password or token.",
    {
      site_url: z.string().optional().describe("Moodle address, e.g. https://moodle.example.edu"),
      code: z.string().optional().describe("Code shown by the sign-in page in link mode (starts with msmcp1.)"),
      method: z
        .enum(["auto", "browser", "link"])
        .optional()
        .describe("auto (default): browser when one can be shown here, else link"),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ site_url, code, method }) => {
      const result = await login({ siteUrl: site_url, code, method });
      if (result.status === "signed_in") session.reset();
      return describeLogin(result);
    },
  );

  tool(
    "auth_status",
    "Show whether the user is signed in to Moodle, as whom, on which site and where the credential comes from " +
      "(environment or saved sign-in). Never reveals the token.",
    {},
    READ_ONLY,
    async () => {
      const browser = browserAttemptState();
      const pending = await loadPendingLogin();
      const extra = {
        ...(browser ? { browser_login: browser } : {}),
        ...(pending ? { link_login_waiting_for_code_until: pending.expiresAt } : {}),
      };
      try {
        const info = await session.run((ctx) => tools.whoami(ctx));
        return { signed_in: true, source: session.credential?.source, ...info, ...extra };
      } catch (error) {
        if (error instanceof NotSignedInError) return { signed_in: false, hint: error.message, ...extra };
        throw error;
      }
    },
  );

  tool(
    "logout",
    "Remove the Moodle sign-in saved on this computer (and any half-finished link login). Does not revoke the " +
      "token on Moodle; the user can do that in Moodle under Preferences > Security keys.",
    {},
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async () => {
      const removed = await clearCredential();
      await clearPendingLogin();
      const source = session.credential?.source;
      session.reset();
      return {
        removed_saved_sign_in: removed,
        ...(source && source !== "saved sign-in"
          ? { note: `Credentials from the environment (${source}) are still configured and will keep being used.` }
          : {}),
      };
    },
  );

  // ---------------------------------------------------------------- moodle

  tool(
    "whoami",
    "Confirm who the user is on Moodle: name, user_id, site, Moodle version, the number of web service " +
      "functions available and the time zone used for dates.",
    {},
    READ_ONLY,
    () => session.run((ctx) => tools.whoami(ctx)),
  );

  tool(
    "list_courses",
    "List the courses the user is enrolled in: id (used by the other tools), name, short name, progress (%) " +
      "and last access.",
    {},
    READ_ONLY,
    () => session.run((ctx) => tools.listCourses(ctx)),
  );

  tool(
    "get_course_contents",
    "List the sections/topics of a course and their activities (name, type, url, description and completion " +
      "state when Moodle exposes it). Use the `id` from list_courses.",
    { course_id: z.number().int().describe("Course id from list_courses") },
    READ_ONLY,
    ({ course_id }) => session.run((ctx) => tools.getCourseContents(ctx, course_id)),
  );

  tool(
    "list_assignments",
    "List assignments with due date, cutoff date, opening date and max grade. Omit `course_ids` to search all " +
      "courses. Returns assign_id for get_submission_status.",
    { course_ids: z.array(z.number().int()).optional().describe("Limit to these course ids") },
    READ_ONLY,
    ({ course_ids }) => session.run((ctx) => tools.listAssignments(ctx, course_ids)),
  );

  tool(
    "get_submission_status",
    "Show the user's own submission for an assignment: status, submission time, whether it can still be " +
      'edited, grade and teacher feedback. Any status other than "submitted" means it was not turned in.',
    { assign_id: z.number().int().describe("assign_id from list_assignments") },
    READ_ONLY,
    ({ assign_id }) => session.run((ctx) => tools.getSubmissionStatus(ctx, assign_id)),
  );

  tool(
    "get_upcoming_deadlines",
    "List upcoming deadlines from Moodle's Timeline (assignment due dates, quiz closings, ...) sorted by date. " +
      "The best single source for what is due and when. Items without a due date do not appear here.",
    { days: z.number().int().min(1).max(366).default(30).describe("Look-ahead window in days") },
    READ_ONLY,
    ({ days }) => session.run((ctx) => tools.getUpcomingDeadlines(ctx, days)),
  );

  tool(
    "get_grades",
    "Show the user's grades in a course: each grade item with grade, max, percentage, weight and feedback.",
    { course_id: z.number().int().describe("Course id from list_courses") },
    READ_ONLY,
    ({ course_id }) => session.run((ctx) => tools.getGrades(ctx, course_id)),
  );

  tool(
    "list_forums",
    'List the forums in the user\'s courses, including the announcements forum (type "news"). Omit ' +
      "`course_ids` to scan all courses. Returns forum_id for get_forum_discussions.",
    { course_ids: z.array(z.number().int()).optional().describe("Limit to these course ids") },
    READ_ONLY,
    ({ course_ids }) => session.run((ctx) => tools.listForums(ctx, course_ids)),
  );

  tool(
    "get_forum_discussions",
    "List the most recent discussions of a forum (title, author, date, opening message). Good for teacher " +
      "announcements.",
    {
      forum_id: z.number().int().describe("forum_id from list_forums"),
      limit: z.number().int().min(1).max(100).default(10).describe("How many discussions"),
    },
    READ_ONLY,
    ({ forum_id, limit }) => session.run((ctx) => tools.getForumDiscussions(ctx, forum_id, limit)),
  );

  tool(
    "list_files",
    "List the downloadable files of a course (PDFs, slides, notebooks, ...): filename, mimetype, size, " +
      "section, activity and the `fileurl` to pass to download_files.",
    { course_id: z.number().int().describe("Course id from list_courses") },
    READ_ONLY,
    ({ course_id }) => session.run((ctx) => tools.listFiles(ctx, course_id)),
  );

  tool(
    "download_files",
    "Download course files to a local folder and return each file's local `path`, so it can be opened and " +
      "read. Pass `fileurls` from list_files, or omit them to download every file in the course. Files already " +
      'downloaded with the same size are reused (status "cached").',
    {
      course_id: z.number().int().describe("Course id from list_courses"),
      fileurls: z.array(z.string()).optional().describe("fileurl values from list_files"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ({ course_id, fileurls }) => session.run((ctx) => tools.downloadFiles(ctx, course_id, fileurls)),
  );

  return server;
}

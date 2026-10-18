// End-to-end smoke test: starts the built server over stdio like an MCP
// client would, then exercises the tools against a real Moodle.
//
//   npm run build
//   node --env-file=.env scripts/smoke.mjs     # MOODLE_URL + MOODLE_TOKEN, or a saved sign-in
//
// Prints summaries only; the token is never printed.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const downloadDir = mkdtempSync(join(tmpdir(), "msmcp-smoke-"));
const server = spawn(process.execPath, ["dist/cli.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, MOODLE_DOWNLOAD_DIR: downloadDir },
});

let nextId = 1;
const waiting = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  waiting.get(message.id)?.(message);
  waiting.delete(message.id);
});

function request(method, params = {}) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function call(name, args = {}) {
  const { result, error } = await request("tools/call", { name, arguments: args });
  if (error) throw new Error(`${name}: ${error.message}`);
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  console.log(`server ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);

  const { result: listed } = await request("tools/list");
  console.log(`tools (${listed.tools.length}): ${listed.tools.map((t) => t.name).join(", ")}`);

  const status = await call("auth_status");
  console.log(`auth_status: signed_in=${status.signed_in} source=${status.source} user=${status.name}`);
  if (!status.signed_in) process.exit(1);

  const me = await call("whoami");
  console.log(`whoami: ${me.name} | ${me.site} | Moodle ${me.version} | ${me.available_functions} functions | tz ${me.time_zone}`);

  const courses = await call("list_courses");
  console.log(`list_courses: ${courses.length}`);
  for (const c of courses.slice(0, 8)) console.log(`  [${c.id}] ${String(c.short_name).split("\n")[0]}`);

  const deadlines = await call("get_upcoming_deadlines", { days: 21 });
  console.log(`get_upcoming_deadlines(21): ${deadlines.length}`);
  for (const d of deadlines.slice(0, 6)) console.log(`  ${d.when} | ${d.event} [${d.still_pending ? "pending" : "ok"}]`);

  const assignments = await call("list_assignments");
  console.log(`list_assignments: ${assignments.length}`);
  if (assignments[0]) {
    const s = await call("get_submission_status", { assign_id: assignments[0].assign_id });
    console.log(`  get_submission_status(${assignments[0].assign_id}): ${s.submission_status} graded=${s.graded}`);
  }

  const forums = await call("list_forums");
  const news = forums.find((f) => f.type === "news");
  console.log(`list_forums: ${forums.length}${news ? `, news forum ${news.forum_id}` : ""}`);
  if (news) console.log(`  get_forum_discussions: ${(await call("get_forum_discussions", { forum_id: news.forum_id, limit: 3 })).length}`);

  for (const course of courses) {
    const files = await call("list_files", { course_id: course.id });
    if (!files.length) continue;
    const grades = await call("get_grades", { course_id: course.id });
    const contents = await call("get_course_contents", { course_id: course.id });
    console.log(`course ${course.id}: ${contents.length} sections, ${files.length} files, ${grades.length} grade items`);
    const smallest = files.filter((f) => f.size_bytes > 0).sort((a, b) => a.size_bytes - b.size_bytes)[0];
    if (smallest) {
      const [r] = await call("download_files", { course_id: course.id, fileurls: [smallest.fileurl] });
      console.log(`  download_files: ${r.status} ${r.size_bytes} bytes -> ${r.path}`);
      const [again] = await call("download_files", { course_id: course.id, fileurls: [smallest.fileurl] });
      console.log(`  second download: ${again.status}`);
    }
    break;
  }
  console.log("smoke test passed");
} catch (error) {
  console.error(`smoke test failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  server.kill();
}

/**
 * Student-level Moodle queries. Each function calls web service functions
 * available to the mobile-app service and returns trimmed, English-keyed data.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { MoodleClient } from "./client.js";
import { formatTimestamp, safeName, stripHtml } from "./format.js";

export interface MoodleContext {
  client: MoodleClient;
  /** IANA zone used to render dates (undefined = system zone). */
  timeZone?: string;
  /** Folder that download_files saves into. */
  downloadDir: string;
}

type Raw = Record<string, any>;

async function enrolledCourses(ctx: MoodleContext): Promise<Raw[]> {
  return ctx.client.call<Raw[]>("core_enrol_get_users_courses", { userid: await ctx.client.userId() });
}

async function allCourseIds(ctx: MoodleContext): Promise<number[]> {
  return (await enrolledCourses(ctx)).map((course) => Number(course.id));
}

interface CourseFile {
  section: Raw;
  module: Raw;
  content: Raw;
}

function courseFiles(sections: Raw[]): CourseFile[] {
  const files: CourseFile[] = [];
  for (const section of sections) {
    for (const module of section.modules ?? []) {
      for (const content of module.contents ?? []) {
        if (content.type === "file" && content.fileurl) files.push({ section, module, content });
      }
    }
  }
  return files;
}

async function courseFolder(ctx: MoodleContext, courseId: number): Promise<string> {
  try {
    const course = (await enrolledCourses(ctx)).find((c) => Number(c.id) === courseId);
    if (course) {
      // Some sites pack class code, schedule and teacher into the name; keep
      // the first line and a readable prefix so paths stay short.
      let label = String(course.shortname || course.fullname || "")
        .replace(/_x000D_/gi, "")
        .split("\n")[0]!
        .trim();
      if (label.length > 60) label = label.slice(0, 60).replace(/\s+\S*$/, "").replace(/[\s\-–_,;:/]+$/, "");
      return safeName(`${courseId} - ${label}`);
    }
  } catch {
    // Fall back to the bare id.
  }
  return String(courseId);
}

const COMPLETION_DONE: Record<number, boolean> = { 0: false, 1: true, 2: true, 3: false };

export async function whoami(ctx: MoodleContext) {
  const info = await ctx.client.call<Raw>("core_webservice_get_site_info");
  return {
    user_id: info.userid,
    name: info.fullname,
    username: info.username,
    site: info.sitename,
    url: info.siteurl,
    version: info.release,
    available_functions: (info.functions ?? []).length,
    time_zone: ctx.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export async function listCourses(ctx: MoodleContext) {
  return (await enrolledCourses(ctx)).map((course) => ({
    id: course.id,
    name: course.fullname,
    short_name: course.shortname,
    progress: course.progress ?? null,
    visible: Boolean(course.visible ?? 1),
    last_access: formatTimestamp(course.lastaccess, ctx.timeZone),
  }));
}

export async function getCourseContents(ctx: MoodleContext, courseId: number) {
  const sections = await ctx.client.call<Raw[]>("core_course_get_contents", { courseid: courseId });
  return sections.map((section) => ({
    section: section.name,
    summary: stripHtml(section.summary),
    activities: (section.modules ?? []).map((module: Raw) => ({
      name: module.name,
      type: module.modname,
      url: module.url ?? null,
      completed: COMPLETION_DONE[module.completiondata?.state as number] ?? null,
      description: stripHtml(module.description),
    })),
  }));
}

export async function listAssignments(ctx: MoodleContext, courseIds?: number[]) {
  const ids = courseIds?.length ? courseIds : await allCourseIds(ctx);
  const data = await ctx.client.call<Raw>("mod_assign_get_assignments", { courseids: ids });
  return (data.courses ?? []).flatMap((course: Raw) =>
    (course.assignments ?? []).map((assignment: Raw) => ({
      course: course.fullname,
      course_id: course.id,
      name: assignment.name,
      assign_id: assignment.id,
      cmid: assignment.cmid,
      due_date: formatTimestamp(assignment.duedate, ctx.timeZone),
      cutoff_date: formatTimestamp(assignment.cutoffdate, ctx.timeZone),
      opens_at: formatTimestamp(assignment.allowsubmissionsfromdate, ctx.timeZone),
      max_grade: assignment.grade,
    })),
  );
}

export async function getSubmissionStatus(ctx: MoodleContext, assignId: number) {
  const data = await ctx.client.call<Raw>("mod_assign_get_submission_status", { assignid: assignId });
  const last = data.lastattempt ?? {};
  const submission = last.submission ?? {};
  const feedback = data.feedback ?? {};

  let feedbackText: string | null = null;
  for (const plugin of feedback.plugins ?? []) {
    for (const field of plugin.editorfields ?? []) {
      if (field.text) feedbackText = stripHtml(field.text);
    }
  }

  return {
    submission_status: submission.status || last.submissionsstatus || null,
    submitted_at: formatTimestamp(submission.timemodified, ctx.timeZone),
    can_edit: Boolean(last.canedit),
    graded: Object.keys(feedback).length > 0,
    grade: feedback.grade?.grade ?? null,
    feedback: feedbackText,
  };
}

export async function getUpcomingDeadlines(ctx: MoodleContext, days = 30) {
  const now = Math.floor(Date.now() / 1000);
  const data = await ctx.client.call<Raw>("core_calendar_get_action_events_by_timesort", {
    timesortfrom: now,
    timesortto: now + days * 86_400,
    limitnum: 50,
  });
  return (data.events ?? []).map((event: Raw) => ({
    event: event.name,
    course: event.course?.fullname ?? null,
    type: event.modulename ?? null,
    when: formatTimestamp(event.timesort, ctx.timeZone),
    action: event.action?.name ?? null,
    still_pending: Boolean(event.action?.actionable),
    url: event.url ?? null,
  }));
}

export async function getGrades(ctx: MoodleContext, courseId: number) {
  const data = await ctx.client.call<Raw>("gradereport_user_get_grade_items", {
    courseid: courseId,
    userid: await ctx.client.userId(),
  });
  return (data.usergrades ?? []).flatMap((report: Raw) =>
    (report.gradeitems ?? []).map((item: Raw) => ({
      item: item.itemname || item.itemtype,
      grade: item.gradeformatted ?? null,
      max: item.grademax ?? null,
      percentage: item.percentageformatted ?? null,
      weight: item.weightformatted ?? null,
      feedback: stripHtml(item.feedback),
    })),
  );
}

export async function listForums(ctx: MoodleContext, courseIds?: number[]) {
  const ids = courseIds?.length ? courseIds : await allCourseIds(ctx);
  const forums = await ctx.client.call<Raw[]>("mod_forum_get_forums_by_courses", { courseids: ids });
  return forums.map((forum) => ({
    forum: forum.name,
    forum_id: forum.id,
    course_id: forum.course,
    type: forum.type,
    description: stripHtml(forum.intro),
  }));
}

export async function getForumDiscussions(ctx: MoodleContext, forumId: number, limit = 10) {
  const data = await ctx.client.call<Raw>("mod_forum_get_forum_discussions", {
    forumid: forumId,
    sortorder: 1,
    page: 0,
    perpage: limit,
  });
  return (data.discussions ?? []).map((discussion: Raw) => ({
    title: discussion.name,
    author: discussion.userfullname,
    created: formatTimestamp(discussion.created, ctx.timeZone),
    message: stripHtml(discussion.message),
  }));
}

export async function listFiles(ctx: MoodleContext, courseId: number) {
  const sections = await ctx.client.call<Raw[]>("core_course_get_contents", { courseid: courseId });
  return courseFiles(sections).map(({ section, module, content }) => ({
    filename: String(content.filename ?? "").normalize("NFC"),
    mimetype: content.mimetype ?? null,
    size_bytes: content.filesize ?? null,
    section: section.name,
    activity: module.name,
    fileurl: content.fileurl,
  }));
}

export async function downloadFiles(ctx: MoodleContext, courseId: number, fileUrls?: string[]) {
  const sections = await ctx.client.call<Raw[]>("core_course_get_contents", { courseid: courseId });
  const folder = join(ctx.downloadDir, await courseFolder(ctx, courseId));

  // Only URLs that belong to this course are fetched, so the token is never
  // sent to an arbitrary address.
  let selected = courseFiles(sections);
  if (fileUrls?.length) {
    const wanted = new Set(fileUrls);
    selected = selected.filter((file) => wanted.has(file.content.fileurl));
  }

  const usedNames = new Map<string, number>();
  const results = [];
  for (const { content } of selected) {
    let filename = safeName(content.filename || "file");
    const seen = usedNames.get(filename.toLowerCase()) ?? 0;
    usedNames.set(filename.toLowerCase(), seen + 1);
    if (seen > 0) {
      const dot = filename.lastIndexOf(".");
      filename = dot > 0 ? `${filename.slice(0, dot)} (${seen + 1})${filename.slice(dot)}` : `${filename} (${seen + 1})`;
    }
    const dest = join(folder, filename);
    const expected = Number(content.filesize ?? -1);
    try {
      const existing = await stat(dest).catch(() => null);
      if (existing && existing.size === expected) {
        results.push({ filename, path: dest, size_bytes: existing.size, status: "cached" });
        continue;
      }
      const size = await ctx.client.download(content.fileurl, dest);
      results.push({ filename, path: dest, size_bytes: size, status: "downloaded" });
    } catch (error) {
      const message = ctx.client.redact(error instanceof Error ? error.message : String(error));
      results.push({ filename, path: null, size_bytes: null, status: `error: ${message}` });
    }
  }
  return results;
}

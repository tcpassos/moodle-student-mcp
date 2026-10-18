import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flattenParams, isInvalidTokenError, MoodleClient, MoodleError } from "../src/moodle/client.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

type Call = { url: string; init?: RequestInit };

function mockFetch(respond: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const jsonResponse = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

describe("flattenParams", () => {
  it("encodes nested values like Moodle expects", () => {
    expect(flattenParams({ courseids: [1, 2], options: { a: true, b: null }, x: "y" })).toEqual({
      "courseids[0]": "1",
      "courseids[1]": "2",
      "options[a]": "1",
      x: "y",
    });
  });
});

describe("MoodleClient.call", () => {
  it("posts the token and params to the REST endpoint", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ ok: 1 }));
    const client = new MoodleClient("https://moodle.test/", TOKEN, { fetch });
    await client.call("mod_assign_get_assignments", { courseids: [7] });

    expect(calls[0]!.url).toBe("https://moodle.test/webservice/rest/server.php");
    const body = calls[0]!.init!.body as URLSearchParams;
    expect(body.get("wstoken")).toBe(TOKEN);
    expect(body.get("wsfunction")).toBe("mod_assign_get_assignments");
    expect(body.get("courseids[0]")).toBe("7");
  });

  it("maps Moodle exceptions to MoodleError", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token" }),
    );
    const client = new MoodleClient("https://moodle.test", TOKEN, { fetch });
    const error = await client.call("core_webservice_get_site_info").catch((e) => e);
    expect(error).toBeInstanceOf(MoodleError);
    expect(isInvalidTokenError(error)).toBe(true);
  });

  it("never puts the token in network error messages", async () => {
    const fetch = (async () => {
      throw new Error(`connect failed for ?token=${TOKEN}`);
    }) as unknown as typeof globalThis.fetch;
    const client = new MoodleClient("https://moodle.test", TOKEN, { fetch });
    const error = await client.call("x").catch((e) => e);
    expect(String(error.message)).not.toContain(TOKEN);
  });
});

describe("MoodleClient.download", () => {
  it("sends the token in the POST body and writes the file", async () => {
    const { fetch, calls } = mockFetch(() => new Response("PDFDATA", { headers: { "content-type": "application/pdf" } }));
    const client = new MoodleClient("https://moodle.test", TOKEN, { fetch });
    const dir = await mkdtemp(join(tmpdir(), "msmcp-dl-"));
    const dest = join(dir, "sub", "file.pdf");
    const fileUrl = "https://moodle.test/webservice/pluginfile.php/1/mod_resource/content/0/file.pdf?forcedownload=1";

    expect(await client.download(fileUrl, dest)).toBe(7);
    expect(await readFile(dest, "utf8")).toBe("PDFDATA");
    expect(calls[0]!.url).toBe(fileUrl);
    expect(calls[0]!.init!.method).toBe("POST");
    expect((calls[0]!.init!.body as URLSearchParams).get("token")).toBe(TOKEN);
  });

  it("falls back to the query string when POST is rejected", async () => {
    const { fetch, calls } = mockFetch((call) =>
      call.init?.method === "POST" ? new Response("", { status: 405 }) : new Response("OK"),
    );
    const client = new MoodleClient("https://moodle.test", TOKEN, { fetch });
    const dir = await mkdtemp(join(tmpdir(), "msmcp-dl-"));
    await client.download("https://moodle.test/webservice/pluginfile.php/1/a.txt", join(dir, "a.txt"));
    expect(new URL(calls[1]!.url).searchParams.get("token")).toBe(TOKEN);
  });

  it("redacts the token from HTTP errors", async () => {
    const { fetch } = mockFetch(() => new Response("", { status: 404 }));
    const client = new MoodleClient("https://moodle.test", TOKEN, { fetch });
    const error = await client
      .download(`https://moodle.test/webservice/pluginfile.php/1/a.txt?token=${TOKEN}`, join(tmpdir(), "never.txt"))
      .catch((e) => e);
    expect(error.message).toContain("404");
    expect(error.message).not.toContain(TOKEN);
  });
});

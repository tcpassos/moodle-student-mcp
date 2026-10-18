/** Helpers that turn raw Moodle values into compact, model-friendly text. */

/** Return `timeZone` if the runtime knows it as an IANA zone, else undefined. */
export function validTimeZone(timeZone: string | undefined | null): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/**
 * Unix timestamp -> ISO 8601 with an explicit offset in `timeZone`, e.g.
 * `2026-10-20T23:59:00-03:00`. 0/null mean "no date" in Moodle and become null.
 */
export function formatTimestamp(ts: unknown, timeZone?: string): string | null {
  const seconds = Number(ts);
  if (!ts || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const zone = get("timeZoneName").replace(/^GMT/, "");
  const offset = zone === "" ? "+00:00" : zone;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  bull: "•",
  middot: "·",
  deg: "°",
  ordm: "º",
  ordf: "ª",
  copy: "©",
  reg: "®",
  euro: "€",
  szlig: "ß",
};

const COMBINING_MARKS: Record<string, string> = {
  acute: "́",
  grave: "̀",
  circ: "̂",
  tilde: "̃",
  uml: "̈",
  cedil: "̧",
  ring: "̊",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    // Accented letters: &aacute; &Ccedil; &otilde; ...
    const accented = /^([a-z])(acute|grave|circ|tilde|uml|cedil|ring)$/i.exec(body);
    if (accented) return (accented[1]! + COMBINING_MARKS[accented[2]!.toLowerCase()]!).normalize("NFC");
    return match;
  });
}

/** Strip HTML tags and collapse whitespace into readable text. Empty -> null. */
export function stripHtml(html: unknown): string | null {
  if (!html) return null;
  let text = String(html);
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Make a string safe as a file or folder name on every OS. */
export function safeName(name: unknown): string {
  let text = String(name ?? "").normalize("NFC");
  text = text.replace(/[\r\n\t]+/g, " ");
  text = text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/[. ]+$/, "");
  if (WINDOWS_RESERVED.test(text)) text = `_${text}`;
  text = text.slice(0, 150).trim();
  return text || "file";
}

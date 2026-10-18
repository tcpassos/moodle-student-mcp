import { describe, expect, it } from "vitest";
import { decodeEntities, formatTimestamp, safeName, stripHtml, validTimeZone } from "../src/moodle/format.js";

describe("formatTimestamp", () => {
  it("renders ISO 8601 with the zone offset", () => {
    expect(formatTimestamp(1_792_551_540, "America/Sao_Paulo")).toBe("2026-10-20T23:59:00-03:00");
    expect(formatTimestamp(1_792_551_540, "UTC")).toBe("2026-10-21T02:59:00+00:00");
  });

  it("treats 0 and empty values as no date", () => {
    expect(formatTimestamp(0, "UTC")).toBeNull();
    expect(formatTimestamp(null, "UTC")).toBeNull();
    expect(formatTimestamp("", "UTC")).toBeNull();
  });
});

describe("validTimeZone", () => {
  it("accepts IANA zones and rejects Moodle's 99 placeholder", () => {
    expect(validTimeZone("America/Sao_Paulo")).toBe("America/Sao_Paulo");
    expect(validTimeZone("99")).toBeUndefined();
    expect(validTimeZone(undefined)).toBeUndefined();
  });
});

describe("stripHtml", () => {
  it("removes tags, scripts and decodes entities", () => {
    expect(stripHtml("<p>Prova&nbsp;1 &amp; 2</p><script>x()</script><br>Avalia&ccedil;&atilde;o &#8211; ok")).toBe(
      "Prova 1 & 2 Avaliação – ok",
    );
    expect(stripHtml("")).toBeNull();
    expect(stripHtml("<p> </p>")).toBeNull();
  });

  it("keeps unknown entities untouched", () => {
    expect(decodeEntities("&unknown; &#x41;")).toBe("&unknown; A");
  });
});

describe("safeName", () => {
  it("sanitizes for every filesystem", () => {
    expect(safeName('a/b\\c:d*e?"f<g>h|i')).toBe("a_b_c_d_e_f_g_h_i");
    expect(safeName("  Aula 1.\n ")).toBe("Aula 1");
    expect(safeName("CON")).toBe("_CON");
    expect(safeName("")).toBe("file");
  });

  it("normalizes decomposed Unicode to NFC", () => {
    const nfd = "Aula Introdução".normalize("NFD");
    expect(safeName(nfd)).toBe("Aula Introdução".normalize("NFC"));
  });
});

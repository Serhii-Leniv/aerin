import { describe, expect, test } from "bun:test";
import { wrapAnsiLine } from "../src/terminal/wrap-ansi.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("wrapAnsiLine", () => {
  test("plain short line passes through untouched", () => {
    expect(wrapAnsiLine("hello", 10)).toEqual(["hello"]);
  });

  test("plain long line hard-wraps at width", () => {
    expect(wrapAnsiLine("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("visible width ignores SGR sequences", () => {
    const line = "\x1b[31mabcdef\x1b[0m";
    const rows = wrapAnsiLine(line, 3);
    expect(rows.map(strip)).toEqual(["abc", "def"]);
  });

  test("active style carries across the break and each row self-terminates", () => {
    const rows = wrapAnsiLine("\x1b[31mabcdef", 3);
    expect(rows[0]!.startsWith("\x1b[31m")).toBe(true);
    expect(rows[0]!.endsWith("\x1b[0m")).toBe(true); // no bleed into the next Ink row
    expect(rows[1]!.startsWith("\x1b[31m")).toBe(true); // color resumes
  });

  test("reset clears carried style", () => {
    const rows = wrapAnsiLine("\x1b[31mab\x1b[0mcdef", 4);
    expect(rows[1]!.startsWith("\x1b[31m")).toBe(false);
  });

  test("OSC hyperlinks count as zero width", () => {
    const link = "\x1b]8;;https://x.dev\x07ab\x1b]8;;\x07cd";
    const rows = wrapAnsiLine(link, 4);
    expect(rows).toHaveLength(1);
  });
});

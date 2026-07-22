import { describe, expect, test } from "bun:test";
import { applyEdit } from "../src/tools/fs-tools.js";

describe("applyEdit", () => {
  test("replaces a unique match", () => {
    expect(applyEdit("hello world", "world", "aerin", false)).toBe("hello aerin");
  });

  test("throws when old_string is missing", () => {
    expect(() => applyEdit("abc", "xyz", "q", false)).toThrow(/not found/);
  });

  test("throws on ambiguous match without replace_all", () => {
    expect(() => applyEdit("a a a", "a", "b", false)).toThrow(/matches 3 times/);
  });

  test("replace_all replaces every occurrence", () => {
    expect(applyEdit("a a a", "a", "b", true)).toBe("b b b");
  });

  test("matches LF old_string against CRLF file and preserves CRLF", () => {
    const file = "line1\r\nline2\r\nline3\r\n";
    const result = applyEdit(file, "line1\nline2", "first\nsecond", false);
    expect(result).toBe("first\r\nsecond\r\nline3\r\n");
  });

  test("matches CRLF old_string against LF file and preserves LF", () => {
    const file = "line1\nline2\n";
    const result = applyEdit(file, "line1\r\nline2", "x\r\ny", false);
    expect(result).toBe("x\ny\n");
  });
});

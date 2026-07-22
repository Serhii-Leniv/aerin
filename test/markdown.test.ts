import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/terminal/markdown.js";

describe("renderMarkdown", () => {
  test("renders markdown bold", () => {
    expect(renderMarkdown("**bold**")).toBe("bold");
  });

  test("renders markdown header", () => {
    expect(renderMarkdown("# header")).toBe("header");
  });

  test("renders markdown list", () => {
    expect(renderMarkdown("- item 1\n- item 2")).toContain("item 1");
    expect(renderMarkdown("- item 1\n- item 2")).toContain("item 2");
  });

  test("falls back to raw text if error occurs", () => {
    const broken = "\[unclosed\[";
    expect(renderMarkdown(broken)).toBe(broken);
  });
});
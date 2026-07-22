import { describe, expect, test } from "bun:test";
import { gradientBanner, gradientLine, sampleGradient } from "../src/terminal/gradient.js";

describe("gradient text", () => {
  test("sampleGradient hits stops at endpoints and blends between", () => {
    const stops = ["#000000", "#ff0000", "#ffffff"];
    expect(sampleGradient(stops, 0)).toBe("0;0;0");
    expect(sampleGradient(stops, 1)).toBe("255;255;255");
    expect(sampleGradient(stops, 0.5)).toBe("255;0;0"); // middle stop exactly
    expect(sampleGradient(stops, 0.25)).toBe("128;0;0"); // halfway into first segment
    expect(sampleGradient(stops, -1)).toBe("0;0;0"); // clamped
    expect(sampleGradient(stops, 2)).toBe("255;255;255");
  });

  test("gradientLine styles glyphs, skips spaces, resets at the end", () => {
    const out = gradientLine("ab c", ["#102030", "#405060"]);
    expect(out).toContain("\x1b[1;38;2;16;32;48ma");
    expect(out).toContain(" "); // space passes through unstyled
    expect(out.endsWith("\x1b[0m")).toBe(true);
    expect(out).not.toContain("m m"); // no styled space
  });

  test("gradientBanner keeps row count and shifts phase per row", () => {
    const rows = gradientBanner(["██", "██", "██"], ["#000000", "#ffffff"]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toBe(rows[2]); // diagonal sweep: later rows sample deeper
  });
});

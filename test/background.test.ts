import { describe, expect, test } from "bun:test";
import { parseOsc11 } from "../src/terminal/background.js";

describe("OSC 11 background classification", () => {
  test("classifies replies as light or dark across channel widths", () => {
    expect(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x07")).toBe(true); // white
    expect(parseOsc11("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe(false); // black
    expect(parseOsc11("\x1b]11;rgb:fdfd/f6f6/e3e3\x07")).toBe(true); // solarized light
    expect(parseOsc11("\x1b]11;rgb:2828/2a2a/3636\x07")).toBe(false); // dracula
    expect(parseOsc11("\x1b]11;rgb:ff/ff/ff\x07")).toBe(true); // 2-digit channels
    expect(parseOsc11("\x1b]11;rgba:0c0c/0c0c/0c0c\x07")).toBe(false); // rgba form (WT default bg)
  });

  test("returns undefined until a complete reply is buffered", () => {
    expect(parseOsc11("")).toBeUndefined();
    expect(parseOsc11("\x1b]11;rg")).toBeUndefined();
    expect(parseOsc11("random keystrokes")).toBeUndefined();
  });
});

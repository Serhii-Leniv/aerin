import { describe, expect, test } from "bun:test";
import { filterChunk } from "../src/terminal/input-filter.js";

describe("filterChunk", () => {
  test("plain text passes through", () => {
    const r = filterChunk("", "hello /model");
    expect(r).toEqual({ carry: "", clean: "hello /model", wheel: [] });
  });

  test("extracts wheel events and strips the sequences", () => {
    const r = filterChunk("", "a\x1b[<64;10;5Mb\x1b[<65;10;6Mc");
    expect(r.clean).toBe("abc");
    expect(r.wheel).toEqual([-1, 1]);
  });

  test("swallows non-wheel mouse events (clicks)", () => {
    const r = filterChunk("", "x\x1b[<0;3;4My\x1b[<0;3;4mz");
    expect(r.clean).toBe("xyz");
    expect(r.wheel).toEqual([]);
  });

  test("carries a partial mouse sequence and completes it next chunk", () => {
    const first = filterChunk("", "abc\x1b[<64;10");
    expect(first.clean).toBe("abc");
    expect(first.carry).toBe("\x1b[<64;10");
    const second = filterChunk(first.carry, ";5M def");
    expect(second.wheel).toEqual([-1]);
    expect(second.clean).toBe(" def");
    expect(second.carry).toBe("");
  });

  test("strips bracketed-paste markers, keeps the payload", () => {
    const r = filterChunk("", "\x1b[200~line1\nline2\x1b[201~");
    expect(r.clean).toBe("line1\nline2");
  });

  test("translates Home/End/Ctrl+arrows to control codes", () => {
    expect(filterChunk("", "\x1b[H").clean).toBe("\x01");
    expect(filterChunk("", "\x1b[1~").clean).toBe("\x01");
    expect(filterChunk("", "\x1b[F").clean).toBe("\x05");
    expect(filterChunk("", "\x1b[4~").clean).toBe("\x05");
    expect(filterChunk("", "\x1b[1;5D").clean).toBe("\x02");
    expect(filterChunk("", "\x1b[1;5C").clean).toBe("\x06");
  });

  test("wheel modifier bits still register as wheel", () => {
    // 64|4 = shift+wheel-up, 65|8 = alt+wheel-down
    expect(filterChunk("", "\x1b[<68;1;1M").wheel).toEqual([-1]);
    expect(filterChunk("", "\x1b[<73;1;1M").wheel).toEqual([1]);
  });
});

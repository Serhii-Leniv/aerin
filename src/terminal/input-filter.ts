/**
 * Terminal input filtering, applied to stdin BEFORE Ink parses it:
 * - SGR mouse sequences are extracted as wheel events (Ink would insert them
 *   into the input as garbage text).
 * - Bracketed-paste markers are stripped (mode 2004 delivers pastes atomically).
 * - Keys Ink's parser can't surface (Home/End/Ctrl+arrows) are translated to
 *   control codes the input widget understands.
 * Pure function over (carry, chunk) so every regex is unit-testable.
 */

export interface FilteredChunk {
  /** Partial mouse sequence held back for the next chunk. */
  carry: string;
  /** Bytes to forward to the key parser. */
  clean: string;
  /** Wheel notches: -1 up (scroll back), +1 down. */
  wheel: number[];
}

export function filterChunk(carry: string, chunk: string): FilteredChunk {
  let s = carry + chunk;
  let nextCarry = "";

  // Hold back a partial mouse sequence split across chunks.
  const partial = /\x1b\[<[\d;]*$/.exec(s);
  if (partial) {
    nextCarry = partial[0];
    s = s.slice(0, partial.index);
  }

  const mouseRe = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
  const wheel: number[] = [];
  let clean = "";
  let last = 0;
  for (let m = mouseRe.exec(s); m; m = mouseRe.exec(s)) {
    clean += s.slice(last, m.index);
    last = m.index + m[0].length;
    const button = Number(m[1]);
    if ((button & 64) !== 0) wheel.push((button & 1) === 0 ? -1 : 1);
    // other mouse events (clicks, drags) are swallowed
  }
  clean += s.slice(last);

  clean = clean
    .replace(/\x1b\[200~|\x1b\[201~/g, "") // bracketed-paste markers
    .replace(/\x1b\[1~|\x1b\[H|\x1bOH/g, "\x01") // Home → Ctrl+A
    .replace(/\x1b\[4~|\x1b\[F|\x1bOF/g, "\x05") // End  → Ctrl+E
    .replace(/\x1b\[1;5D/g, "\x02") // Ctrl+← → word left
    .replace(/\x1b\[1;5C/g, "\x06"); // Ctrl+→ → word right

  return { carry: nextCarry, clean, wheel };
}

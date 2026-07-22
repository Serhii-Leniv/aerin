/**
 * ANSI-aware hard wrap: split a styled line into rows of at most `width`
 * visible characters without breaking escape sequences, carrying active SGR
 * styling across the break. This makes the transcript's scroll buffer count
 * VISUAL rows, so scrolling by line matches what the terminal shows.
 */

// SGR color/style sequences and OSC sequences (hyperlinks, titles) — zero width.
const TOKEN_RE = /(\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

export function wrapAnsiLine(line: string, width: number): string[] {
  if (width <= 0) return [line];
  // Fast path: nothing to wrap.
  if (!line.includes("\x1b") && line.length <= width) return [line];

  const rows: string[] = [];
  let row = "";
  let visible = 0;
  let active: string[] = []; // SGR sequences in effect (reset clears)

  const breakRow = (): void => {
    rows.push(active.length > 0 ? row + "\x1b[0m" : row);
    row = active.join("");
    visible = 0;
  };

  let last = 0;
  for (const m of line.matchAll(TOKEN_RE)) {
    // Plain text between tokens: emit char by char, breaking at width.
    for (const ch of line.slice(last, m.index)) {
      if (visible >= width) breakRow();
      row += ch;
      visible++;
    }
    last = m.index + m[0].length;
    const token = m[0];
    if (token.startsWith("\x1b[")) {
      if (token === "\x1b[0m" || token === "\x1b[m") active = [];
      else active.push(token);
    }
    row += token; // zero-width: SGR state or OSC passthrough
  }
  for (const ch of line.slice(last)) {
    if (visible >= width) breakRow();
    row += ch;
    visible++;
  }
  rows.push(row);
  return rows;
}

/**
 * Truecolor gradient text — the lipgloss/tui-banner technique that gives
 * modern TUIs their look: hero elements sweep through a multi-stop gradient
 * per character, diagonally across banner rows.
 */

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Sample a multi-stop gradient at t in [0,1] → "r;g;b". */
export function sampleGradient(stops: readonly string[], t: number): string {
  if (stops.length === 1) return rgb(stops[0]!).join(";");
  const clamped = Math.min(1, Math.max(0, t));
  const seg = Math.min(stops.length - 2, Math.floor(clamped * (stops.length - 1)));
  const local = clamped * (stops.length - 1) - seg;
  const a = rgb(stops[seg]!);
  const b = rgb(stops[seg + 1]!);
  return a.map((av, i) => Math.round(av + (b[i]! - av) * local)).join(";");
}

/** One line swept left→right through the gradient, bold. Spaces stay unstyled. */
export function gradientLine(text: string, stops: readonly string[], phase = 0, spread = 1): string {
  const chars = [...text];
  const denom = Math.max(1, chars.length - 1);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === " ") {
      out += ch;
      continue;
    }
    out += `\x1b[1;38;2;${sampleGradient(stops, phase + (i / denom) * spread)}m${ch}`;
  }
  return out + "\x1b[0m";
}

/** Banner rows with a diagonal sweep — each row starts deeper into the gradient. */
export function gradientBanner(rows: readonly string[], stops: readonly string[]): string[] {
  const rowStep = rows.length > 1 ? 0.35 / (rows.length - 1) : 0;
  return rows.map((row, r) => gradientLine(row, stops, r * rowStep, 0.65));
}

/**
 * Aerin's color theme: Navy — a deep-blue brand, serious and steady. True
 * navy is unreadable as text on a dark terminal, so the brand splits by
 * background (the Klein-void discipline): royal/steel blue renditions on
 * dark, true navy on light. Central palette: UI code refers to roles, never
 * raw colors, so retheming is a one-file change. The palette is mutable so
 * background detection can swap in the light-terminal variants before first
 * render.
 */
export const C = {
  /** Interactive accent: prompts, model name, pickers, links. */
  accent: "#7aa2f7", // steel blue — navy's readable voice on dark
  /** Main brand hero: the wordmark, prompt marker, borders. */
  accentBright: "#4d8bff", // royal blue — hero moments, bold
  /** Secondary/meta text. */
  dim: "#6272a4", // muted blue-gray
  /** Success / done. */
  ok: "#50fa7b", // green
  /** Warnings, in-progress, queued. */
  warn: "#e6c86e", // soft gold — stays visible on white terminals
  /** Errors and destructive hints. */
  error: "#ff5555", // red
  /** Plan mode, section headers, reasoning. */
  magenta: "#bd93f9", // soft purple
  /** Code accents (params, punctuation warmth). */
  orange: "#ffb86c",
  /** Default foreground (rarely set explicitly — terminal fg is close). */
  fg: "#f8f8f2",
};

/** Same roles re-picked for white/light terminal backgrounds — true navy. */
const LIGHT: typeof C = {
  accent: "#1d4ed8", // deep blue
  accentBright: "#1e3a8a", // true navy hero
  dim: "#5f6b8c",
  ok: "#1f9d55",
  warn: "#9a7b00",
  error: "#d63031",
  magenta: "#7048b6",
  orange: "#c2571a",
  fg: "#1a1a2e",
};

/** Swap the palette for a light terminal background. Call before first render. */
export function applyBackgroundTheme(light: boolean): void {
  if (light) Object.assign(C, LIGHT);
}

/** "r;g;b" for raw ANSI truecolor sequences built from theme hexes. */
export function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

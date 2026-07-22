/**
 * Aerin's color theme: Navy — the whole gamma is keyed to dark blue, not just
 * the accent. Grays are navy-grays, the foreground is blue-tinted, and the
 * semantic colors are the Tokyo Night family, tuned to harmonize with blue.
 * True navy is unreadable as text on a dark terminal, so the brand splits by
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
  /** Secondary/meta text — navy-gray, the key color's undertone. */
  dim: "#565f89",
  /** Success / done — herb green, harmonizes with blue. */
  ok: "#9ece6a",
  /** Warnings, in-progress, queued — warm amber. */
  warn: "#e0af68",
  /** Errors and destructive hints — rose red. */
  error: "#f7768e",
  /** Plan mode, section headers, reasoning — periwinkle. */
  magenta: "#bb9af7",
  /** Code accents (params, punctuation warmth). */
  orange: "#ff9e64",
  /** Default foreground — blue-tinted, carries the navy key into prose. */
  fg: "#c0caf5",
};

/** Same roles re-picked for white/light terminal backgrounds — true navy. */
const LIGHT: typeof C = {
  accent: "#2e7de9", // day blue
  accentBright: "#1e3a8a", // true navy hero
  dim: "#68709a",
  ok: "#587539",
  warn: "#8f6c1e",
  error: "#c53b53",
  magenta: "#7847bd",
  orange: "#b15c00",
  fg: "#2e3f6e", // navy-tinted ink
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

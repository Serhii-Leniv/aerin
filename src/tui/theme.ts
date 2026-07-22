/**
 * Aerin's color theme: Cyberpunk Synthwave, tuned for reading — one pink hero
 * for identity moments, a softened sky-cyan for interactive text (full-neon
 * cyan halates on dark and vanishes on light backgrounds), Dracula-family
 * accents. Central palette: UI code refers to roles, never raw colors, so
 * retheming is a one-file change. The palette is mutable so background
 * detection can swap in the light-terminal variants before first render.
 */
export const C = {
  /** Interactive accent: prompts, model name, pickers, links. */
  accent: "#5cc8ff", // sky cyan — readable as text on dark and light
  /** Main brand hero: the wordmark, prompt marker, borders. */
  accentBright: "#ff77a9", // electric pink
  /** Secondary/meta text. */
  dim: "#6272a4", // muted purple-gray
  /** Success / done. */
  ok: "#50fa7b", // neon green
  /** Warnings, in-progress, queued. */
  warn: "#e6c86e", // soft gold — stays visible on white terminals
  /** Errors and destructive hints. */
  error: "#ff5555", // hot red
  /** Plan mode, section headers, reasoning. */
  magenta: "#bd93f9", // synth purple
  /** Code accents (params, punctuation warmth). */
  orange: "#ffb86c",
  /** Default foreground (rarely set explicitly — terminal fg is close). */
  fg: "#f8f8f2",
};

/** Same roles re-picked for white/light terminal backgrounds. */
const LIGHT: typeof C = {
  accent: "#006db8", // deep sky
  accentBright: "#d6336c", // raspberry — pink hero, darkened for white
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

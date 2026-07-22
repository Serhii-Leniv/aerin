/**
 * Aerin's color theme: Pop N' Lock (after Luxcium's VS Code theme) — vivid,
 * balanced colors on a deep navy ground: pink-red hero #ee3366, bright-blue
 * interactive voice, lime success, golden warnings, warm cream foreground.
 * Central palette: UI code refers to roles, never raw colors, so retheming is
 * a one-file change. The palette is mutable so background detection can swap
 * in the light-terminal variants before first render.
 */
export const C = {
  /** Interactive accent: prompts, model name, pickers, links. */
  accent: "#88bbdd", // bright blue — Pop N' Lock's variable/link blue family
  /** Main brand hero: the wordmark, prompt marker, borders. */
  accentBright: "#ee3366", // vivid pink-red — the theme's signature pop
  /** Secondary/meta text — slate with the navy ground's undertone. */
  dim: "#6e739e",
  /** Success / done — lime (ansiBrightGreen). */
  ok: "#b5d033",
  /** Warnings, in-progress, queued — golden (ansiBrightYellow). */
  warn: "#face2f",
  /** Errors and destructive hints — rust red (ansiRed), distinct from the pink hero. */
  error: "#cc371e",
  /** Plan mode, section headers, reasoning — bright magenta. */
  magenta: "#c055a9",
  /** Code accents (params, punctuation warmth) — amber (ansiYellow). */
  orange: "#e79931",
  /** Default foreground — Pop N' Lock's warm cream. */
  fg: "#d2c8be",
  /** Hero gradient stops (kept for brand moments): pink-red into magenta. */
  heroGradient: ["#ee3366", "#dd6688", "#c055a9"] as readonly string[],
};

/** Same roles re-picked for white/light terminal backgrounds. */
const LIGHT: typeof C = {
  accent: "#3e7ca6",
  accentBright: "#c11e50", // deepened pink-red hero for white
  dim: "#6d6f8a",
  ok: "#6b7d10", // olive lime
  warn: "#9a7b00",
  error: "#b32e14",
  magenta: "#93387f",
  orange: "#b26a12",
  fg: "#3a3733", // warm ink
  heroGradient: ["#c11e50", "#a83a6e", "#93387f"] as readonly string[],
};

let lightMode = false;

/** Swap the palette for a light terminal background. Call before first render. */
export function applyBackgroundTheme(light: boolean): void {
  lightMode = light;
  if (light) Object.assign(C, LIGHT);
}

/** Whether the light-background palette is active. */
export function isLightTheme(): boolean {
  return lightMode;
}

/** "r;g;b" for raw ANSI truecolor sequences built from theme hexes. */
export function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

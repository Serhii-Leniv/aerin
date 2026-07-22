/**
 * Aerin's color theme: Emerald Night — jade over dark moss. The whole gamma
 * is keyed to deep green: green-gray meta text, mint-tinted foreground, and
 * a jade → mint → lime hero gradient. Success stays a distinct lighter mint;
 * plan/reasoning takes a cool sky counterpoint so the green key never blurs
 * with semantics. Central palette: UI code refers to roles, never raw colors,
 * so retheming is a one-file change. The palette is mutable so background
 * detection can swap in the light-terminal variants before first render.
 */
export const C = {
  /** Interactive accent: prompts, model name, pickers, links. */
  accent: "#6ee7b7", // spring mint — the readable voice on dark
  /** Main brand hero: the wordmark, prompt marker, borders. */
  accentBright: "#2dd4a7", // jade — hero moments, bold
  /** Secondary/meta text — moss-gray, the key color's undertone. */
  dim: "#56705f",
  /** Success / done — pale mint, lighter than the brand jade. */
  ok: "#86efac",
  /** Warnings, in-progress, queued — dry amber. */
  warn: "#d9b45f",
  /** Errors and destructive hints — soft coral. */
  error: "#ef8f8f",
  /** Plan mode, section headers, reasoning — sky counterpoint. */
  magenta: "#93c5fd",
  /** Code accents (params, punctuation warmth). */
  orange: "#d9a662",
  /** Default foreground — mint-tinted, carries the green key into prose. */
  fg: "#c3e8d1",
  /** Hero gradient (wordmark, brand moments): jade → mint → lime. */
  heroGradient: ["#2dd4a7", "#86efac", "#d9f99d"] as readonly string[],
};

/** Same roles re-picked for white/light terminal backgrounds — deep forest. */
const LIGHT: typeof C = {
  accent: "#047857", // emerald ink
  accentBright: "#065f46", // deep jade hero
  dim: "#5b6e63",
  ok: "#2f7d4a",
  warn: "#8a6d1e",
  error: "#c04343",
  magenta: "#2563eb",
  orange: "#a16207",
  fg: "#173b2c", // forest ink
  heroGradient: ["#065f46", "#059669", "#65a30d"] as readonly string[],
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

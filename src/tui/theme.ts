/**
 * Aerin's color theme: Cyberpunk Synthwave, tuned for reading — one pink hero
 * for identity moments, a softened sky-cyan for interactive text (full-neon
 * cyan halates on dark and vanishes on light backgrounds), Dracula-family
 * accents. Central palette: UI code refers to roles, never raw colors, so
 * retheming is a one-file change.
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
  /** Default foreground (rarely set explicitly — terminal fg is close). */
  fg: "#f8f8f2",
} as const;

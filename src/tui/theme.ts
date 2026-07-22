/**
 * Aerin's color theme: the terminal.sexy default scheme (Tomorrow Night
 * lineage). Central palette — UI code refers to roles, not raw colors.
 * https://terminal.sexy
 */
/** Cyberpunk Synthwave — electric pink brand, cyan voice, Dracula accents. */
export const C = {
  /** Primary accent: prompts, agent responses, model name, pickers. */
  accent: "#00f2fe", // cyan blue
  /** Main brand / header art — logo gradient top. */
  accentBright: "#ff77a9", // electric pink
  /** Secondary/meta text. */
  dim: "#6272a4", // muted purple-gray
  /** Success / done. */
  ok: "#50fa7b", // neon green
  /** Warnings, in-progress, queued. */
  warn: "#f1fa8c", // neon yellow
  /** Errors and destructive hints. */
  error: "#ff5555", // hot red
  /** Plan mode, section headers. */
  magenta: "#bd93f9", // synth purple
  /** Default foreground (rarely set explicitly — terminal fg is close). */
  fg: "#f8f8f2",
} as const;

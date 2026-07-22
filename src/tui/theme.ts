/**
 * Aerin's color theme: the terminal.sexy default scheme (Tomorrow Night
 * lineage). Central palette — UI code refers to roles, not raw colors.
 * https://terminal.sexy
 */
export const C = {
  /** Primary accent: prompts, model name, pickers, logo. */
  accent: "#8abeb7", // bright cyan
  accentBright: "#81a2be", // bright blue — logo gradient top
  /** Secondary/meta text. */
  dim: "#707880",
  /** Success / done. */
  ok: "#b5bd68",
  /** Warnings, in-progress, queued. */
  warn: "#f0c674",
  /** Errors and destructive hints. */
  error: "#cc6666",
  /** Plan mode, section headers. */
  magenta: "#b294bb",
  /** Default foreground (rarely set explicitly — terminal fg is close). */
  fg: "#c5c8c6",
} as const;

/** Logo gradient, top to bottom. */
export const LOGO_GRADIENT = [C.accentBright, C.accentBright, C.accent, C.accent] as const;

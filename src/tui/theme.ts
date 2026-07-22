/**
 * Aerin's color theme: the terminal.sexy default scheme (Tomorrow Night
 * lineage). Central palette — UI code refers to roles, not raw colors.
 * https://terminal.sexy
 */
export const C = {
  /** Primary accent: prompts, model name, pickers, logo. */
  accent: "#cc6666", // red — aerin's primary
  accentBright: "#b5bd68", // green — logo gradient top, secondary accent
  /** Secondary/meta text. */
  dim: "#707880",
  /** Success / done. */
  ok: "#b5bd68",
  /** Warnings, in-progress, queued. */
  warn: "#f0c674",
  /** Errors and destructive hints — darker than the accent red. */
  error: "#a54242",
  /** Plan mode, section headers. */
  magenta: "#b294bb",
  /** Default foreground (rarely set explicitly — terminal fg is close). */
  fg: "#c5c8c6",
} as const;

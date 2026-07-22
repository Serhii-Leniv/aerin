/**
 * Aerin's color theme: the terminal.sexy default scheme (Tomorrow Night
 * lineage). Central palette — UI code refers to roles, not raw colors.
 * https://terminal.sexy
 */
export const C = {
  /** Primary accent: prompts, model name, pickers, logo — aerin's mint-teal. */
  accent: "#2dd4bf",
  /** Logo gradient top: sky blue fading into the teal. */
  accentBright: "#60a5fa",
  /** Secondary/meta text. */
  dim: "#707880",
  /** Success / done. */
  ok: "#b5bd68",
  /** Warnings, in-progress, queued — warm amber, the teal's counterpart. */
  warn: "#f0c674",
  /** Errors and destructive hints. */
  error: "#cc6666",
  /** Plan mode, section headers. */
  magenta: "#b294bb",
  /** Default foreground (rarely set explicitly — terminal fg is close). */
  fg: "#c5c8c6",
} as const;

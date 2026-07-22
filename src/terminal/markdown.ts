import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { C, rgbOf } from "../tui/theme.js";

/**
 * Terminal markdown rendering: width-aware reflow (re-configured when the
 * terminal width changes), styled to aerin's theme palette via raw ANSI
 * (no chalk dependency), with a fallback pass for inline markdown that
 * marked-terminal leaves literal inside list items.
 */

// Match chalk's discipline: no ANSI when output isn't a color terminal.
// Colors resolve from the theme at CALL time so background detection
// (light-terminal palette swap) applies even though this module loads first.
const colorEnabled = Boolean(process.env["FORCE_COLOR"]) || process.stdout.isTTY === true;
const wrap = (get: () => string, bold = false) => (s: string) =>
  colorEnabled ? `\x1b[${bold ? "1;" : ""}38;2;${rgbOf(get())}m${s}\x1b[0m` : s;
const pink = wrap(() => C.accentBright, true); // headings — brand pink, bold
const cyan = wrap(() => C.accent); // links
const dim = wrap(() => C.dim); // blockquotes, hr
const yellow = wrap(() => C.warn); // inline code

// Syntax theme for fenced code (highlight.js token names).
const pinkPlain = wrap(() => C.accentBright);
const green = wrap(() => C.ok);
const purple = wrap(() => C.magenta);
const orange = wrap(() => C.orange);
const fg = wrap(() => C.fg);
const id = (s: string) => s;
// Pop N' Lock fidelity: gold functions/classes, lime strings, pink-red types.
const SYNTAX_THEME = {
  keyword: fg,
  built_in: cyan,
  type: pinkPlain,
  literal: purple,
  number: orange,
  regexp: green,
  string: green,
  class: yellow,
  function: yellow,
  title: yellow,
  params: orange,
  comment: dim,
  doctag: dim,
  meta: dim,
  tag: pinkPlain,
  name: cyan,
  attr: green,
  attribute: green,
  variable: fg,
  symbol: purple,
  bullet: cyan,
  addition: green,
  deletion: wrap(() => C.error),
  default: id,
};

let instance: Marked | undefined;
let configuredWidth = 0;

function ensure(width: number): Marked {
  if (instance && configuredWidth === width) return instance;
  configuredWidth = width;
  instance = new Marked();
  const railed = (s: string) =>
    s
      .split("\n")
      .map((l) => `${dim("│")} ${l.replace(/^ {4}/, "")}`)
      .join("\n");
  // OSC 8: clickable links in modern terminals (Windows Terminal, iTerm, ...).
  const clickable = (href: string) => `\x1b]8;;${href}\x07${cyan(href)}\x1b]8;;\x07`;
  instance.use(
    markedTerminal({
      width,
      reflowText: true,
      showSectionPrefix: false,
      tab: 2,
      firstHeading: pink,
      heading: pink,
      link: cyan,
      href: colorEnabled ? clickable : (s: string) => s,
      blockquote: dim,
      hr: dim,
      codespan: yellow,
      code: railed, // fenced blocks get a dim left rail instead of bare indent
    }, colorEnabled ? { theme: SYNTAX_THEME as never } : undefined) as Parameters<Marked["use"]>[0],
  );
  return instance;
}

/** Render markdown for the terminal; falls back to raw text on any failure. */
export function renderMarkdown(text: string, width = 80): string {
  try {
    const out = ensure(Math.max(30, width)).parse(text, { async: false });
    if (typeof out !== "string") return text;
    return inlineFallback(out.trimEnd()).replace(/^(\s*)\* /gm, "$1• ");
  } catch {
    return text;
  }
}

/**
 * marked-terminal styles inline markdown in paragraphs but leaves it literal
 * inside list items — finish the job for the common cases. When the output
 * already carries ANSI styling, use ANSI; otherwise just strip the markers.
 */
function inlineFallback(text: string): string {
  const styled = text.includes("\x1b[");
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, (_, t: string) => (styled ? `\x1b[1m${t}\x1b[22m` : t))
    .replace(/__([^_\n]+)__/g, (_, t: string) => (styled ? `\x1b[1m${t}\x1b[22m` : t))
    .replace(/(?<![`\w])`([^`\n]+)`(?!`)/g, (_, t: string) => (styled ? yellow(t) : t));
}

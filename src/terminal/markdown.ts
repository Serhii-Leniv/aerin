import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;

/** Render markdown for the terminal; falls back to raw text on any failure. */
export function renderMarkdown(text: string): string {
  try {
    if (!configured) {
      // No "#" prefixes on headings — they render styled, not as raw markdown.
      marked.use(markedTerminal({ showSectionPrefix: false }) as Parameters<typeof marked.use>[0]);
      configured = true;
    }
    const out = marked.parse(text, { async: false });
    return typeof out === "string" ? inlineFallback(out.trimEnd()) : text;
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
    .replace(/(?<![`\w])`([^`\n]+)`(?!`)/g, (_, t: string) => (styled ? `\x1b[33m${t}\x1b[39m` : t));
}

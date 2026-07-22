import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;

/** Render markdown for the terminal; falls back to raw text on any failure. */
export function renderMarkdown(text: string): string {
  try {
    if (!configured) {
      marked.use(markedTerminal() as Parameters<typeof marked.use>[0]);
      configured = true;
    }
    const out = marked.parse(text, { async: false });
    return typeof out === "string" ? out.trimEnd() : text;
  } catch {
    return text;
  }
}

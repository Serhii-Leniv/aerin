import fs from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 5;
const MAX_CHARS_PER_FILE = 20_000;
const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 2_000_000;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface AttachedImage {
  /** Base64 payload — string form survives JSONL session storage intact. */
  data: string;
  mediaType: string;
  name: string;
}

export interface ExpandedPrompt {
  text: string;
  images: AttachedImage[];
}

/**
 * Expand "@path/to/file" tokens: text files are appended to the prompt,
 * images (png/jpg/gif/webp) become multimodal attachments for vision models.
 * Tokens that don't resolve to a real file are left untouched.
 */
export async function expandMentions(prompt: string, cwd: string): Promise<ExpandedPrompt> {
  const tokens = [...prompt.matchAll(/(?:^|\s)@([\w~][\w./\\-]*)/g)]
    .map((m) => m[1])
    .filter((t): t is string => Boolean(t));
  if (tokens.length === 0) return { text: prompt, images: [] };

  const attachments: string[] = [];
  const images: AttachedImage[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const abs = path.resolve(cwd, token);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      const mediaType = IMAGE_TYPES[path.extname(abs).toLowerCase()];
      if (mediaType) {
        if (images.length >= MAX_IMAGES || stat.size > MAX_IMAGE_BYTES) continue;
        const buf = await fs.readFile(abs);
        images.push({ data: buf.toString("base64"), mediaType, name: token });
        continue;
      }
      if (attachments.length >= MAX_FILES) continue;
      const raw = await fs.readFile(abs, "utf8");
      const clipped = raw.length > MAX_CHARS_PER_FILE ? raw.slice(0, MAX_CHARS_PER_FILE) + "\n[...truncated]" : raw;
      attachments.push(`[Attached file: ${token}]\n${clipped}`);
    } catch {
      continue; // not a file — leave the token as plain text
    }
  }
  const text = attachments.length > 0 ? `${prompt}\n\n${attachments.join("\n\n")}` : prompt;
  return { text, images };
}

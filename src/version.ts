import fs from "node:fs";

/** Single source of truth: package.json sits one level above src/ and dist/ alike. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

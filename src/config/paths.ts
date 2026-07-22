import path from "node:path";
import crypto from "node:crypto";
import envPaths from "env-paths";

const paths = envPaths("aerin", { suffix: "" });

export const GLOBAL_CONFIG_DIR = paths.config;
export const GLOBAL_CONFIG_FILE = path.join(paths.config, "config.json");
export const DATA_DIR = paths.data;

export function projectConfigDir(cwd: string): string {
  return path.join(cwd, ".aerin");
}

export function projectSettingsFile(cwd: string): string {
  return path.join(projectConfigDir(cwd), "settings.json");
}

export function sessionsDir(cwd: string): string {
  const hash = crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12);
  return path.join(DATA_DIR, "sessions", hash);
}

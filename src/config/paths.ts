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

function projectHash(cwd: string): string {
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

export function sessionsDir(cwd: string): string {
  return path.join(DATA_DIR, "sessions", projectHash(cwd));
}

/** Shadow git repo for /undo snapshots — lives in the data dir, never inside the project. */
export function shadowGitDir(cwd: string): string {
  return path.join(DATA_DIR, "shadow", projectHash(cwd));
}

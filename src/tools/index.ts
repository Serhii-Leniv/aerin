import type { ToolDef } from "./types.js";
import { readTool, writeTool, editTool, lsTool } from "./fs-tools.js";
import { globTool, grepTool } from "./search-tools.js";
import { bashTool } from "./bash.js";

export function builtinTools(): ToolDef[] {
  return [readTool, writeTool, editTool, lsTool, globTool, grepTool, bashTool];
}

export type { ToolDef, ToolContext, PermissionTier } from "./types.js";

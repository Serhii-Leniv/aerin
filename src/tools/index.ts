import type { ToolDef } from "./types.js";
import { readTool, writeTool, editTool, lsTool } from "./fs-tools.js";
import { globTool, grepTool } from "./search-tools.js";
import { bashTool } from "./bash.js";
import { webFetchTool, webSearchTool } from "./web-tools.js";
import { todoTool } from "./todo-tool.js";
import { memoryTool } from "./memory-tool.js";

export function builtinTools(): ToolDef[] {
  return [
    readTool,
    writeTool,
    editTool,
    lsTool,
    globTool,
    grepTool,
    bashTool,
    webSearchTool,
    webFetchTool,
    todoTool,
    memoryTool,
  ];
}

export type { ToolDef, ToolContext, PermissionTier } from "./types.js";

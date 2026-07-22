import { streamText, tool as aiTool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { AgentEvent, OnPermission } from "./events.js";
import type { ToolDef, ToolContext } from "../tools/types.js";
import { PermissionPolicy, targetFor } from "../permissions/policy.js";
import { persistProjectRule } from "../config/config.js";
import { estimateCostUsd } from "../providers/models.js";
import { shouldCompact, compact } from "./compact.js";
import type { SessionStore } from "../session/store.js";

const MAX_ITERATIONS = 50;

/**
 * Strip non-JSON values (undefined properties, class instances) from
 * provider-returned messages. Some providers (seen: OpenRouter's
 * reasoning_details) attach `undefined` fields inside providerOptions,
 * which fails the AI SDK's ModelMessage validation on the NEXT request —
 * and would corrupt our JSONL session files anyway.
 */
export function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Providers throw strings, Errors, and bare objects — normalize to a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const o = err as Record<string, unknown>;
    if (typeof o["message"] === "string") return o["message"];
    if (typeof o["error"] === "object" && o["error"] !== null) {
      const inner = o["error"] as Record<string, unknown>;
      if (typeof inner["message"] === "string") return inner["message"];
    }
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export interface AgentOptions {
  model: LanguageModel;
  modelId: string;
  systemPrompt: string;
  tools: ToolDef[];
  policy: PermissionPolicy;
  onPermission: OnPermission;
  cwd: string;
  allowOutsideCwd: boolean;
  store?: SessionStore;
  initialMessages?: ModelMessage[];
  /** Tool-iteration cap per send(); sub-agents run with a lower cap. */
  maxIterations?: number;
}

export class Agent {
  private messages: ModelMessage[];
  private toolsByName: Map<string, ToolDef>;
  private lastInputTokens = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCostUsd = 0;
  private currentAbort: AbortController | undefined;

  constructor(private opts: AgentOptions) {
    this.messages = [...(opts.initialMessages ?? [])];
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  }

  get history(): readonly ModelMessage[] {
    return this.messages;
  }

  abort(): void {
    this.currentAbort?.abort();
  }

  setModel(model: LanguageModel, modelId: string): void {
    this.opts.model = model;
    this.opts.modelId = modelId;
  }

  get modelId(): string {
    return this.opts.modelId;
  }

  get model(): LanguageModel {
    return this.opts.model;
  }

  /** Register a tool after construction — needed by tools that close over this Agent. */
  registerTool(def: ToolDef): void {
    this.opts.tools.push(def);
    this.toolsByName.set(def.name, def);
  }

  async clear(): Promise<void> {
    this.messages = [];
    await this.opts.store?.rewrite([]);
  }

  async compactNow(): Promise<void> {
    this.messages = await compact(this.opts.model, this.messages);
    await this.opts.store?.rewrite(this.messages);
  }

  /** Declare tool schemas only — never `execute` — so the permission gate interposes. */
  private buildToolSet(): ToolSet {
    const set: ToolSet = {};
    for (const t of this.opts.tools) {
      set[t.name] = aiTool({ description: t.description, inputSchema: t.inputSchema });
    }
    return set;
  }

  async *send(input: string): AsyncIterable<AgentEvent> {
    const abort = new AbortController();
    this.currentAbort = abort;
    const newMessages: ModelMessage[] = [];
    const userMessage: ModelMessage = { role: "user", content: input };
    this.messages.push(userMessage);
    newMessages.push(userMessage);

    const toolCtx: ToolContext = {
      cwd: this.opts.cwd,
      abortSignal: abort.signal,
      allowOutsideCwd: this.opts.allowOutsideCwd,
    };

    try {
      const maxIterations = this.opts.maxIterations ?? MAX_ITERATIONS;
      let finished = false;
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (shouldCompact(this.opts.modelId, this.lastInputTokens)) {
          const pre = this.lastInputTokens;
          yield { type: "compaction", preTokens: pre };
          await this.compactNow();
          this.lastInputTokens = 0;
        }

        const result = streamText({
          model: this.opts.model,
          system: this.opts.systemPrompt,
          messages: this.messages,
          tools: this.buildToolSet(),
          abortSignal: abort.signal,
          // Errors surface through our event stream; without this the SDK
          // also dumps the raw error object to the console.
          onError: () => {},
        });

        const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];
        let sawText = false;

        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            sawText = true;
            yield { type: "text-delta", text: part.text };
          } else if (part.type === "reasoning-delta") {
            yield { type: "reasoning-delta", text: part.text };
          } else if (part.type === "tool-call") {
            toolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
          } else if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(errorMessage(part.error));
          }
        }
        if (sawText) yield { type: "message-end" };

        const response = await result.response;
        const sanitized = response.messages.map((m) => toPlainJson(m));
        this.messages.push(...sanitized);
        newMessages.push(...sanitized);

        const usage = await result.usage;
        const inTok = usage.inputTokens ?? 0;
        const outTok = usage.outputTokens ?? 0;
        this.lastInputTokens = inTok;
        this.totalInputTokens += inTok;
        this.totalOutputTokens += outTok;
        const cost = estimateCostUsd(this.opts.modelId, inTok, outTok);
        if (cost !== undefined) this.totalCostUsd += cost;
        yield { type: "usage", inputTokens: inTok, outputTokens: outTok, costUsd: cost };

        if (toolCalls.length === 0) {
          finished = true;
          break;
        }

        const toolResults: ModelMessage = { role: "tool", content: [] };
        for (const call of toolCalls) {
          const { output, isError } = yield* this.dispatchToolCall(call, toolCtx);
          yield { type: "tool-result", id: call.toolCallId, name: call.toolName, output, isError };
          (toolResults.content as unknown[]).push({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: isError ? "error-text" : "text", value: output },
          });
        }
        this.messages.push(toolResults);
        newMessages.push(toolResults);
      }
      if (!finished) {
        yield {
          type: "error",
          message: `Stopped after ${maxIterations} tool iterations — say "continue" to keep going.`,
        };
      }
    } catch (err) {
      if (abort.signal.aborted) {
        // Providers reject histories with dangling tool calls, so patch any
        // unanswered calls with synthetic cancelled results before returning.
        this.patchDanglingToolCalls(newMessages);
        yield { type: "error", message: "Interrupted." };
      } else {
        yield { type: "error", message: errorMessage(err) };
      }
    } finally {
      this.currentAbort = undefined;
      await this.opts.store?.append(newMessages).catch(() => {});
    }
    yield { type: "turn-end" };
  }

  private async *dispatchToolCall(
    call: { toolCallId: string; toolName: string; input: unknown },
    ctx: ToolContext,
  ): AsyncGenerator<AgentEvent, { output: string; isError: boolean }> {
    const def = this.toolsByName.get(call.toolName);
    if (!def) return { output: `Unknown tool: ${call.toolName}`, isError: true };

    // MCP tools carry a JSON-Schema passthrough instead of zod — skip local validation there.
    const maybeZod = def.inputSchema as {
      safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } };
    };
    let input: unknown = call.input;
    if (typeof maybeZod.safeParse === "function") {
      const parsed = maybeZod.safeParse(call.input);
      if (!parsed.success) {
        // Return the validation error as the tool result so the model self-corrects.
        return { output: `Invalid tool input: ${parsed.error?.message ?? "schema mismatch"}`, isError: true };
      }
      input = parsed.data;
    }
    const summary = def.summarize(input);
    yield { type: "tool-call", id: call.toolCallId, name: call.toolName, input, summary };

    const target = targetFor(call.toolName, input);
    if (this.opts.policy.decide(def.permission, target) === "ask") {
      yield { type: "permission-request", id: call.toolCallId, name: call.toolName, summary };
      const preview = def.preview ? await def.preview(input, ctx).catch(() => undefined) : undefined;
      const decision = await this.opts.onPermission({
        tool: call.toolName,
        input,
        summary,
        ...(preview !== undefined ? { preview } : {}),
      });
      if (decision.kind === "deny") {
        return {
          output: `User denied permission for this action.${decision.reason ? ` Instruction: ${decision.reason}` : ""}`,
          isError: true,
        };
      }
      if (decision.kind === "allow-always") {
        const rule = PermissionPolicy.ruleFor(target);
        this.opts.policy.addSessionRule(rule);
        if (decision.scope === "project") {
          await persistProjectRule(this.opts.cwd, rule).catch(() => {});
        }
      }
    }

    // Pump: run execute() while yielding any progress events it pushes (e.g.
    // sub-agent status), so the UI stays live during long tool runs.
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const progressCtx: ToolContext = {
      ...ctx,
      toolCallId: call.toolCallId,
      onProgress: (e) => {
        queue.push(e);
        wake?.();
      },
    };
    let settled = false;
    let output = "";
    let error: unknown;
    void def
      .execute(input, progressCtx)
      .then(
        (r) => {
          output = r;
        },
        (e: unknown) => {
          error = e ?? new Error("Tool failed.");
        },
      )
      .finally(() => {
        settled = true;
        wake?.();
      });

    while (!settled || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      const e = queue.shift() as AgentEvent;
      // Fold sub-agent spend into this agent's totals so every frontend's
      // meter stays truthful without UI-specific accounting.
      if (e.type === "subagent-update" && e.status !== "running") {
        this.totalInputTokens += e.inputTokens;
        this.totalOutputTokens += e.outputTokens;
        if (e.costUsd !== undefined) this.totalCostUsd += e.costUsd;
      }
      yield e;
    }

    if (error !== undefined) {
      if (ctx.abortSignal?.aborted) throw error;
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
    return { output, isError: false };
  }

  /** Add synthetic tool results for any assistant tool calls with no matching result. */
  private patchDanglingToolCalls(newMessages: ModelMessage[]): void {
    const answered = new Set<string>();
    const called = new Map<string, string>();
    for (const m of this.messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === "object" && part !== null && "type" in part && part.type === "tool-call") {
            const p = part as { toolCallId: string; toolName: string };
            called.set(p.toolCallId, p.toolName);
          }
        }
      }
      if (m.role === "tool" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (typeof part === "object" && part !== null && "toolCallId" in part) {
            answered.add((part as { toolCallId: string }).toolCallId);
          }
        }
      }
    }
    const dangling = [...called].filter(([id]) => !answered.has(id));
    if (dangling.length === 0) return;
    const patch: ModelMessage = {
      role: "tool",
      content: dangling.map(([toolCallId, toolName]) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output: { type: "error-text" as const, value: "Cancelled by user." },
      })),
    };
    this.messages.push(patch);
    newMessages.push(patch);
  }
}

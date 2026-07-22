import { APICallError, streamText, tool as aiTool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { AgentEvent, OnPermission } from "./events.js";
import type { ToolDef, ToolContext } from "../tools/types.js";
import { PermissionPolicy, targetFor } from "../permissions/policy.js";
import { persistProjectRule } from "../config/config.js";
import { estimateCostUsd } from "../providers/models.js";
import { shouldCompact, compact } from "./compact.js";
import { Checkpoints } from "./checkpoints.js";
import path from "node:path";
import type { SessionStore } from "../session/store.js";

const MAX_ITERATIONS = 50;
/** Extra whole-request retries when the stream fails before producing content. */
const MAX_STREAM_RETRIES = 2;

/** Transient provider failures worth retrying: rate limits, overload, network. */
export function isRetryableError(err: unknown): boolean {
  // Exhausted quotas won't recover in seconds — retrying just wastes a minute.
  const raw = errorMessage(err).toLowerCase();
  if (/per.day|daily|quota|insufficient.credit|billing|payment/.test(raw)) return false;
  if (APICallError.isInstance(err)) {
    if (err.isRetryable) return true;
    const sc = err.statusCode;
    if (sc !== undefined && [408, 409, 429, 500, 502, 503, 529].includes(sc)) return true;
  }
  const msg = errorMessage(err).toLowerCase();
  if (/overloaded|rate.?limit|too many requests|timed? ?out|econnreset|econnrefused|fetch failed|socket|network error/.test(msg)) {
    return true;
  }
  return /\b(429|500|502|503|529)\b/.test(msg);
}

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
  private checkpoints = new Checkpoints();

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

  /** Swap in a previously saved session (store + full message history). */
  loadSession(store: SessionStore, messages: ModelMessage[]): void {
    this.opts.store = store;
    this.messages = [...messages];
  }

  /** Undo the file changes of the most recent turn that changed anything. */
  async undo(): Promise<string[]> {
    return this.checkpoints.undoLastChange();
  }

  async compactNow(): Promise<void> {
    this.messages = await compact(this.opts.model, this.messages);
    await this.opts.store?.rewrite(this.messages);
    // The old provider-reported context size no longer describes this history;
    // without the reset, shouldCompact() would re-fire on the next turn.
    this.lastInputTokens = 0;
  }

  /** Rough size of the current history (~4 chars/token) — for the meter between requests. */
  estimateContextTokens(): number {
    return Math.round(JSON.stringify(this.messages).length / 4);
  }

  /**
   * Request prompt fields. Non-Anthropic models get the plain `system` option.
   * Anthropic models get the system prompt as a message with cache breakpoints
   * on it and on the latest message (plus allowSystemInMessages, the sanctioned
   * form), so the unchanged prefix bills at the cached rate (~10%) on every
   * iteration. Clones — never mutates — stored history, so the moving
   * breakpoint is not persisted to the session file.
   */
  private requestPrompt(): {
    system?: string;
    messages: ModelMessage[];
    allowSystemInMessages?: boolean;
  } {
    if (!this.opts.modelId.startsWith("anthropic/")) {
      return { system: this.opts.systemPrompt, messages: this.messages };
    }
    const cacheOpts = { anthropic: { cacheControl: { type: "ephemeral" } } };
    const withCache = (m: ModelMessage): ModelMessage =>
      ({ ...m, providerOptions: { ...(m as { providerOptions?: object }).providerOptions, ...cacheOpts } }) as ModelMessage;
    const system = withCache({ role: "system", content: this.opts.systemPrompt } as ModelMessage);
    const last = this.messages[this.messages.length - 1];
    const messages = last ? [system, ...this.messages.slice(0, -1), withCache(last)] : [system];
    return { messages, allowSystemInMessages: true };
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
    await this.opts.store?.ensureTitle(input);
    this.checkpoints.beginTurn();

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

        const toolCalls: { toolCallId: string; toolName: string; input: unknown }[] = [];
        let sawText = false;
        let result!: ReturnType<typeof streamText>;

        // Retry the whole request when the stream dies on a transient provider
        // error BEFORE any content arrived; once content streamed, fail honestly.
        for (let attempt = 0; ; attempt++) {
          result = streamText({
            model: this.opts.model,
            ...this.requestPrompt(),
            tools: this.buildToolSet(),
            abortSignal: abort.signal,
            // Errors surface through our event stream; without this the SDK
            // also dumps the raw error object to the console.
            onError: () => {},
          });

          let received = false;
          try {
            for await (const part of result.fullStream) {
              if (part.type === "text-delta") {
                received = true;
                sawText = true;
                yield { type: "text-delta", text: part.text };
              } else if (part.type === "reasoning-delta") {
                received = true;
                yield { type: "reasoning-delta", text: part.text };
              } else if (part.type === "tool-call") {
                received = true;
                toolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
              } else if (part.type === "error") {
                throw part.error instanceof Error ? part.error : new Error(errorMessage(part.error));
              }
            }
            break;
          } catch (err) {
            if (received || attempt >= MAX_STREAM_RETRIES || abort.signal.aborted || !isRetryableError(err)) {
              throw err;
            }
            toolCalls.length = 0;
            yield {
              type: "retry",
              attempt: attempt + 1,
              maxAttempts: MAX_STREAM_RETRIES + 1,
              message: errorMessage(err),
            };
            const delay = 1500 * (attempt + 1);
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, delay);
              abort.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  resolve();
                },
                { once: true },
              );
            });
          }
        }
        if (sawText) yield { type: "message-end" };

        const response = await result.response;
        const sanitized = response.messages.map((m) => toPlainJson(m));
        this.messages.push(...sanitized);
        newMessages.push(...sanitized);

        const usage = await result.usage;
        // Cached input is excluded from inputTokens but still occupies context —
        // count it so the meter reflects the true conversation size.
        const inTok = (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
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
        // Sub-agent calls are independent read-only research — run a batch of
        // them concurrently; everything else stays strictly sequential.
        const agentCalls = toolCalls.filter((c) => c.toolName === "agent");
        const sequential =
          agentCalls.length > 1 ? toolCalls.filter((c) => c.toolName !== "agent") : toolCalls;
        if (agentCalls.length > 1) {
          yield* this.dispatchParallel(agentCalls, toolCtx, toolResults);
        }
        for (const call of sequential) {
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

  /**
   * Drive several dispatch generators concurrently, funneling their events
   * through one queue; results are appended in the original call order.
   * Used only for `agent` (sub-agent) calls: read-tier, so no permission
   * dialogs can interleave.
   */
  private async *dispatchParallel(
    calls: { toolCallId: string; toolName: string; input: unknown }[],
    ctx: ToolContext,
    toolResults: ModelMessage,
  ): AsyncGenerator<AgentEvent, void> {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const outcomes = new Map<string, { output: string; isError: boolean }>();
    let pending = calls.length;
    let abortError: unknown;

    for (const call of calls) {
      void (async () => {
        try {
          const gen = this.dispatchToolCall(call, ctx);
          for (;;) {
            const r = await gen.next();
            if (r.done) {
              outcomes.set(call.toolCallId, r.value);
              return;
            }
            queue.push(r.value);
            wake?.();
          }
        } catch (err) {
          if (ctx.abortSignal?.aborted) abortError ??= err;
          outcomes.set(call.toolCallId, { output: errorMessage(err), isError: true });
        } finally {
          pending--;
          wake?.();
        }
      })();
    }

    while (pending > 0 || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      yield queue.shift() as AgentEvent;
    }
    if (abortError !== undefined) throw abortError;

    for (const call of calls) {
      const res = outcomes.get(call.toolCallId) ?? { output: "(no result)", isError: true };
      yield { type: "tool-result", id: call.toolCallId, name: call.toolName, output: res.output, isError: res.isError };
      (toolResults.content as unknown[]).push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: res.isError ? "error-text" : "text", value: res.output },
      });
    }
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
    const policyDecision = this.opts.policy.decide(def.permission, target);
    if (policyDecision === "deny") {
      return {
        output:
          "Plan mode is active: only read-only tools are allowed. Investigate with read/grep/glob/agent, " +
          "then present a numbered step-by-step plan and stop — the user approves by turning plan mode off (/plan).",
        isError: true,
      };
    }
    if (policyDecision === "ask") {
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

    // Capture the file's pre-change state so /undo can restore this turn.
    if (def.permission === "write") {
      const p = (input as { path?: unknown })?.path;
      if (typeof p === "string" && p) {
        await this.checkpoints.record(path.resolve(this.opts.cwd, p)).catch(() => {});
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

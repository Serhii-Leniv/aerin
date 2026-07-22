import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { LanguageModel, ModelMessage } from "ai";
import type { Agent } from "../core/agent.js";
import type { OnPermission, PermissionDecision, PermissionRequest } from "../core/events.js";
import type { AerinConfig } from "../config/config.js";
import { MODEL_TABLE, modelInfo } from "../providers/models.js";
import { PROVIDERS } from "../providers/registry.js";
import { discoverModels, formatModelLabel, type DiscoveredModel } from "../providers/list-models.js";
import { VERSION } from "../version.js";
import { SessionStore, type SessionSummary } from "../session/store.js";
import { renderMarkdown } from "../terminal/markdown.js";
import { relativeTime } from "../terminal/format.js";
import { DiffText, FilterSelect, LineInput, SelectList, Spinner } from "./components/widgets.js";

/** Everything the TUI needs, assembled by run.tsx. */
export interface TuiSetup {
  agent: Agent;
  modelId: string;
  cwd: string;
  warnings: string[];
  /** Swappable so the dialog can be wired after agent construction. */
  onPermissionRef: { current: OnPermission };
  resolveModelFn: (id: string) => LanguageModel;
  config: AerinConfig;
  /** Set when startup could not resolve a model; forces the picker open first. */
  modelUnavailable?: string;
}

/**
 * Ink rendering rules baked in here:
 * - Everything above the fold lives in <Static> (append-only) to avoid
 *   O(n^2) redraws and flicker; only the in-flight message is dynamic.
 * - Stream re-renders are batched to ~50ms, never per-token setState.
 * - No alt-screen: normal scrollback is a feature.
 * - Raw mode eats Ctrl+C, so double-Ctrl+C-to-exit is implemented explicitly.
 */

interface TranscriptItem {
  key: number;
  kind: "banner" | "user" | "assistant" | "tool" | "tool-error" | "info" | "error";
  text: string;
}

/** Grouped picker rows: one header per provider, models beneath it. */
function buildPickerItems(models: DiscoveredModel[]): { label: string; value: string; header?: boolean }[] {
  const items: { label: string; value: string; header?: boolean }[] = [];
  let lastProvider = "";
  for (const m of models) {
    if (m.provider !== lastProvider) {
      lastProvider = m.provider;
      items.push({
        label: `${PROVIDERS[m.provider]?.name ?? m.provider}`,
        value: `__header_${m.provider}`,
        header: true,
      });
    }
    items.push({ label: formatModelLabel(m, { stripProvider: true }), value: m.id });
  }
  return items;
}

interface PendingPermission {
  req: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
}

const HELP_TEXT = `Commands: /help /clear /compact /model [provider/id] /resume /exit
Esc interrupts a running turn. Ctrl+C twice exits.`;

const SLASH_COMMANDS = [
  { name: "/model", description: "switch model — pick from a live list, or /model provider/id" },
  { name: "/compact", description: "summarize the conversation to free context" },
  { name: "/clear", description: "clear conversation history" },
  { name: "/resume", description: "resume a previous conversation in this directory" },
  { name: "/help", description: "show commands and keys" },
  { name: "/exit", description: "quit aerin" },
] as const;

/** "⏺ " on the first line, aligned indent on the rest — Claude Code-style blocks. */
function withDot(text: string): string {
  const lines = text.split("\n");
  return ["⏺ " + (lines[0] ?? ""), ...lines.slice(1).map((l) => "  " + l)].join("\n");
}

/** One-line result stat for the ⎿ line: short outputs verbatim, long ones as a count. */
function resultStat(output: string, isError: boolean): string {
  const trimmed = output.trim();
  if (!trimmed) return "(no output)";
  const lines = trimmed.split("\n");
  const first = (lines[0] ?? "").slice(0, 120);
  if (isError) return first;
  if (lines.length === 1 && first.length <= 100) return first;
  return `${lines.length} lines`;
}

/** Concatenated text parts of a saved message (string or parts array). */
function messageText(m: ModelMessage): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as { type?: string; text?: string }[])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1e3).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function App(props: { setup: TuiSetup; initialPrompt?: string }): React.ReactElement {
  const { setup } = props;
  const { exit } = useApp();

  const [items, setItems] = useState<TranscriptItem[]>(() => [
    { key: 0, kind: "banner", text: "" },
    ...setup.warnings.map((w, i) => ({ key: i + 1, kind: "error" as const, text: `warning: ${w}` })),
  ]);
  const [streaming, setStreaming] = useState("");
  const [working, setWorking] = useState(false);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [denyReasonMode, setDenyReasonMode] = useState(false);
  const [modelPicker, setModelPicker] = useState<"loading" | DiscoveredModel[] | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionSummary[] | null>(null);
  const [exitArmed, setExitArmed] = useState(false);
  const [stats, setStats] = useState({ inTok: 0, outTok: 0, cost: 0 });
  const [modelId, setModelId] = useState(setup.modelId);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [thinking, setThinking] = useState(false);
  const [reasoningTail, setReasoningTail] = useState("");
  const [ctxTokens, setCtxTokens] = useState(0);
  const [subagents, setSubagents] = useState<
    Map<string, { description: string; lastTool?: string; toolCalls: number }>
  >(new Map());
  const reasoningBuf = useRef("");
  const reasoningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nextKey = useRef(100);
  const streamBuf = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workingRef = useRef(false);

  const pushItem = useCallback((kind: TranscriptItem["kind"], text: string) => {
    setItems((prev) => [...prev, { key: nextKey.current++, kind, text }]);
  }, []);

  // Wire the agent's permission callback to the dialog.
  useEffect(() => {
    setup.onPermissionRef.current = (req) =>
      new Promise<PermissionDecision>((resolve) => setPermission({ req, resolve }));
  }, [setup]);

  const flushStream = useCallback(() => {
    flushTimer.current = null;
    // Render markdown live while streaming — partial constructs (an unclosed
    // code fence, a half-typed **bold) degrade gracefully in marked-terminal.
    setStreaming(withDot(renderMarkdown(streamBuf.current)));
  }, []);

  const runTurn = useCallback(
    async (prompt: string) => {
      workingRef.current = true;
      setWorking(true);
      pushItem("user", prompt);
      try {
        for await (const event of setup.agent.send(prompt)) {
          switch (event.type) {
            case "reasoning-delta": {
              setThinking(true);
              reasoningBuf.current += event.text;
              if (!reasoningTimer.current) {
                reasoningTimer.current = setTimeout(() => {
                  reasoningTimer.current = null;
                  // Show only the tail — enough to follow along without flooding.
                  const lines = reasoningBuf.current.split("\n").filter((l) => l.trim());
                  setReasoningTail(lines.slice(-3).join("\n"));
                }, 80);
              }
              break;
            }
            case "text-delta": {
              setThinking(false);
              reasoningBuf.current = "";
              setReasoningTail("");
              streamBuf.current += event.text;
              if (!flushTimer.current) flushTimer.current = setTimeout(flushStream, 50);
              break;
            }
            case "message-end": {
              if (flushTimer.current) clearTimeout(flushTimer.current);
              flushTimer.current = null;
              const text = streamBuf.current;
              streamBuf.current = "";
              setStreaming("");
              if (text.trim()) pushItem("assistant", withDot(renderMarkdown(text)));
              break;
            }
            case "tool-call":
              pushItem("tool", `⏺ ${event.summary}`);
              break;
            case "tool-result": {
              const stat = resultStat(event.output, event.isError);
              pushItem(event.isError ? "tool-error" : "info", `  ⎿  ${event.isError ? "✗ " : ""}${stat}`);
              break;
            }
            case "compaction":
              pushItem("info", `[compacting context — was ${event.preTokens} tokens]`);
              break;
            case "subagent-update": {
              if (event.status === "running") {
                setSubagents((m) =>
                  new Map(m).set(event.id, {
                    description: event.description,
                    ...(event.lastTool !== undefined ? { lastTool: event.lastTool } : {}),
                    toolCalls: event.toolCalls,
                  }),
                );
              } else {
                setSubagents((m) => {
                  const next = new Map(m);
                  next.delete(event.id);
                  return next;
                });
                const tok = fmtTokens(event.inputTokens + event.outputTokens);
                pushItem(
                  event.status === "error" ? "tool-error" : "info",
                  `  ⎿  agent ${event.status}: ${event.description} (${event.toolCalls} tools, ${tok} tok${event.costUsd ? `, ~$${event.costUsd.toFixed(4)}` : ""})`,
                );
                // Sub-agent spend is folded into the agent totals by the core loop.
                setStats({
                  inTok: setup.agent.totalInputTokens,
                  outTok: setup.agent.totalOutputTokens,
                  cost: setup.agent.totalCostUsd,
                });
              }
              break;
            }
            case "usage":
              setCtxTokens(event.inputTokens); // context size of the latest request
              setStats({
                inTok: setup.agent.totalInputTokens,
                outTok: setup.agent.totalOutputTokens,
                cost: setup.agent.totalCostUsd,
              });
              break;
            case "error":
              pushItem("error", event.message);
              break;
            default:
              break;
          }
        }
      } finally {
        workingRef.current = false;
        setWorking(false);
        setThinking(false);
        setReasoningTail("");
        reasoningBuf.current = "";
        setPermission(null);
        setSubagents(new Map()); // clear stragglers on abort/error
      }
    },
    [setup, pushItem, flushStream],
  );

  // Re-render a saved conversation into the transcript, Claude Code-style:
  // user/assistant text plus one-liners for the tool calls between them.
  const replayHistory = useCallback((messages: readonly ModelMessage[]) => {
    const add: TranscriptItem[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        const t = messageText(m);
        if (t.trim()) add.push({ key: nextKey.current++, kind: "user", text: t });
      } else if (m.role === "assistant") {
        if (Array.isArray(m.content)) {
          for (const part of m.content as { type?: string; text?: string; toolName?: string }[]) {
            if (part?.type === "text" && part.text?.trim()) {
              add.push({ key: nextKey.current++, kind: "assistant", text: withDot(renderMarkdown(part.text)) });
            } else if (part?.type === "tool-call" && part.toolName) {
              add.push({ key: nextKey.current++, kind: "tool", text: `⏺ ${part.toolName}` });
            }
          }
        } else {
          const t = messageText(m);
          if (t.trim()) add.push({ key: nextKey.current++, kind: "assistant", text: withDot(renderMarkdown(t)) });
        }
      }
    }
    setItems((prev) => [...prev, ...add]);
  }, []);

  const resumeSession = useCallback(
    async (id: string): Promise<void> => {
      const { store, messages } = await SessionStore.open(setup.cwd, id);
      setup.agent.loadSession(store, messages);
      pushItem("info", `── resumed conversation (${messages.length} messages) ──`);
      replayHistory(messages);
    },
    [setup, pushItem, replayHistory],
  );

  const handleCommand = useCallback(
    async (line: string): Promise<void> => {
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "/help":
          pushItem("info", HELP_TEXT);
          return;
        case "/clear":
          await setup.agent.clear();
          pushItem("info", "(history cleared)");
          return;
        case "/compact":
          if (setup.agent.history.length === 0) {
            pushItem("info", "(nothing to compact — history is empty)");
            return;
          }
          await setup.agent.compactNow();
          pushItem("info", "(compacted)");
          return;
        case "/exit":
        case "/quit":
          exit();
          return;
        case "/resume": {
          if (arg) {
            await resumeSession(arg);
            return;
          }
          // Empty sessions are noise — only offer conversations with content.
          const sessions = (await SessionStore.list(setup.cwd)).filter((s) => s.messageCount > 0);
          if (sessions.length === 0) {
            pushItem("info", "(no previous conversations in this directory)");
            return;
          }
          setSessionPicker(sessions);
          return;
        }
        case "/model": {
          if (arg) {
            switchModel(arg);
            return;
          }
          setModelPicker("loading");
          const { models, warnings } = await discoverModels(setup.config);
          for (const w of warnings) pushItem("error", w);
          if (models.length > 0) {
            setModelPicker(models);
          } else {
            // No provider reachable — fall back to the known-model metadata table.
            pushItem("info", "No provider model lists reachable — showing known models. You can always type /model provider/any-id directly.");
            setModelPicker(
              Object.entries(MODEL_TABLE).map(([id, info]) => ({
                id,
                provider: id.split("/")[0] ?? "",
                contextWindow: info.contextWindow,
                ...(info.inputPerMTok !== undefined ? { inputPerMTok: info.inputPerMTok } : {}),
                ...(info.outputPerMTok !== undefined ? { outputPerMTok: info.outputPerMTok } : {}),
              })),
            );
          }
          return;
        }
        default:
          pushItem("error", `Unknown command: ${cmd}. Try /help.`);
      }
    },
    [setup, pushItem, exit, resumeSession],
  );

  // A failing command must never take down the TUI (or vanish silently).
  const runCommand = useCallback(
    (line: string): void => {
      handleCommand(line).catch((err) => pushItem("error", err instanceof Error ? err.message : String(err)));
    },
    [handleCommand, pushItem],
  );

  const switchModel = useCallback(
    (id: string) => {
      try {
        const model = setup.resolveModelFn(id);
        setup.agent.setModel(model, id);
        setModelId(id);
        pushItem("info", `Model switched to ${id}`);
      } catch (err) {
        pushItem("error", err instanceof Error ? err.message : String(err));
      }
    },
    [setup, pushItem],
  );

  const onSubmit = useCallback(
    (value: string) => {
      const line = value.trim();
      if (!line || workingRef.current) return;
      setInputHistory((h) => (h[h.length - 1] === line ? h : [...h, line].slice(-100)));
      if (line.startsWith("/")) {
        runCommand(line);
      } else {
        void runTurn(line);
      }
    },
    [runCommand, runTurn],
  );

  // Global keys: Esc interrupts; double Ctrl+C exits.
  useInput((input, key) => {
    if (key.escape && workingRef.current) {
      setup.agent.abort();
      return;
    }
    if (key.ctrl && input === "c") {
      if (workingRef.current) {
        setup.agent.abort();
        return;
      }
      if (exitArmed) {
        exit();
      } else {
        setExitArmed(true);
        setTimeout(() => setExitArmed(false), 1500);
      }
    }
  });

  useEffect(() => {
    // A session continued via -c/-r arrives with history — show it.
    if (setup.agent.history.length > 0) {
      pushItem("info", `── continuing conversation (${setup.agent.history.length} messages) ──`);
      replayHistory(setup.agent.history);
    }
    // With no usable model the startup warning already says to run /model;
    // keep the input active (auto-opening the picker would swallow typed
    // commands) and skip any initial prompt — the stub model can't run it.
    if (props.initialPrompt && !setup.modelUnavailable) void runTurn(props.initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputActive = !working && !permission && !modelPicker && !sessionPicker;

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) =>
          item.kind === "banner" ? (
            <Box
              key={item.key}
              flexDirection="column"
              borderStyle="round"
              borderColor="cyan"
              paddingX={2}
              marginBottom={1}
              alignSelf="flex-start"
            >
              <Text>
                <Text color="cyan" bold>
                  ✦ Aerin
                </Text>
                <Text color="gray"> v{VERSION} — open-source coding agent</Text>
              </Text>
              <Text> </Text>
              <Text>
                <Text color="gray">model </Text>
                {setup.modelId}
              </Text>
              <Text>
                <Text color="gray">cwd   </Text>
                {setup.cwd}
              </Text>
              <Text> </Text>
              <Text color="gray">/help commands · /model switch model · Esc interrupt · Ctrl+C twice quit</Text>
            </Box>
          ) : (
            <Box key={item.key} marginBottom={item.kind === "assistant" || item.kind === "user" ? 1 : 0}>
              <Text
                color={
                  item.kind === "user"
                    ? "cyan"
                    : item.kind === "error" || item.kind === "tool-error"
                      ? "red"
                      : item.kind === "info"
                        ? "gray"
                        : undefined
                }
              >
                {item.kind === "user" ? `> ${item.text}` : item.text}
              </Text>
            </Box>
          )
        }
      </Static>

      {streaming ? <Text>{streaming}</Text> : null}
      {thinking && reasoningTail ? (
        <Box flexDirection="column" marginBottom={0}>
          <Text color="gray" dimColor>
            {reasoningTail}
          </Text>
        </Box>
      ) : null}
      {subagents.size > 0 ? (
        <Box flexDirection="column">
          {[...subagents.entries()].map(([id, s]) => (
            <Text key={id} color="gray">
              {"  "}◐ {s.description} — {s.toolCalls} tools · {s.lastTool ?? "starting"}
            </Text>
          ))}
        </Box>
      ) : null}
      {working && !permission ? (
        <Spinner label={thinking ? "thinking — Esc to interrupt" : "working — Esc to interrupt"} />
      ) : null}

      {permission && !denyReasonMode ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">Permission: {permission.req.summary}</Text>
          {permission.req.preview ? <DiffText diff={permission.req.preview} maxLines={25} /> : null}
          <SelectList
            active={true}
            items={[
              { label: "Yes", value: "allow" },
              { label: "Yes, always for this project", value: "always" },
              { label: "No — tell the agent what to do instead", value: "deny" },
            ]}
            onSelect={(v) => {
              if (v === "allow") {
                permission.resolve({ kind: "allow" });
                setPermission(null);
              } else if (v === "always") {
                permission.resolve({ kind: "allow-always", scope: "project" });
                setPermission(null);
              } else {
                setDenyReasonMode(true);
              }
            }}
          />
        </Box>
      ) : null}

      {permission && denyReasonMode ? (
        <Box borderStyle="round" borderColor="red" paddingX={1}>
          <LineInput
            prompt="Why / what instead? "
            active={true}
            onSubmit={(reason) => {
              permission.resolve({ kind: "deny", ...(reason.trim() ? { reason: reason.trim() } : {}) });
              setPermission(null);
              setDenyReasonMode(false);
            }}
          />
        </Box>
      ) : null}

      {modelPicker === "loading" ? (
        <Text color="gray">… fetching available models from your providers</Text>
      ) : null}

      {modelPicker && modelPicker !== "loading" ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan">Pick a model (current: {modelId}) — type to filter, Esc to cancel</Text>
          <FilterSelect
            active={true}
            items={buildPickerItems(modelPicker)}
            onCancel={() => setModelPicker(null)}
            onSelect={(id) => {
              setModelPicker(null);
              switchModel(id);
            }}
          />
        </Box>
      ) : null}

      {sessionPicker ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan">Resume a conversation — type to filter, Esc to cancel</Text>
          <FilterSelect
            active={true}
            items={sessionPicker.map((s) => ({
              label: `${relativeTime(s.createdAt).padEnd(11)} ${String(s.messageCount).padStart(3)} msg  ${s.title ?? "(no prompt yet)"}`,
              value: s.id,
            }))}
            onCancel={() => setSessionPicker(null)}
            onSelect={(id) => {
              setSessionPicker(null);
              resumeSession(id).catch((err) =>
                pushItem("error", err instanceof Error ? err.message : String(err)),
              );
            }}
          />
        </Box>
      ) : null}

      {inputActive ? (
        <LineInput
          prompt="> "
          active={inputActive}
          onSubmit={onSubmit}
          history={inputHistory}
          commands={SLASH_COMMANDS}
        />
      ) : null}

      <Box>
        <Text color="gray">
          {modelId}
          {ctxTokens > 0
            ? ` · ctx ${fmtTokens(ctxTokens)}/${fmtTokens(modelInfo(modelId).contextWindow)} (${Math.round((ctxTokens / modelInfo(modelId).contextWindow) * 100)}%)`
            : ""}
          {" · "}
          {fmtTokens(stats.inTok)} in / {fmtTokens(stats.outTok)} out
          {stats.cost > 0 ? ` · ~$${stats.cost.toFixed(4)}` : ""}
          {exitArmed ? " · press Ctrl+C again to exit" : ""}
        </Text>
      </Box>
    </Box>
  );
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import type { LanguageModel, ModelMessage } from "ai";
import type { Agent } from "../core/agent.js";
import type { OnPermission, PermissionDecision, PermissionRequest } from "../core/events.js";
import { persistModelChoice, persistProviderKey, type AerinConfig } from "../config/config.js";
import { renderCommand, type CustomCommand } from "../core/commands.js";
import { allKnownModels, modelInfo } from "../providers/models.js";
import { PROVIDERS, providersWithKeys, resolveApiKey } from "../providers/registry.js";
import { PROVIDER_CATALOG, catalogEntry, keyLooksLike } from "../providers/catalog.js";
import { discoverModels, formatModelLabel, listProviderModels, type DiscoveredModel } from "../providers/list-models.js";
import { VERSION } from "../version.js";
import { SessionStore, type SessionSummary } from "../session/store.js";
import type { AskUser } from "../tools/question-tool.js";
import type { TodoItem } from "../tools/todo-tool.js";
import type { PermissionMode, PermissionPolicy } from "../permissions/policy.js";
import { renderMarkdown } from "../terminal/markdown.js";
import { messageText, redactSecrets, relativeTime, setTerminalTitle } from "../terminal/format.js";
import { expandMentions } from "../core/mentions.js";
import { DiffText, FilterSelect, LineInput, SelectList, Spinner } from "./components/widgets.js";
import { C } from "./theme.js";

/** Everything the TUI needs, assembled by run.tsx. */
export interface TuiSetup {
  agent: Agent;
  modelId: string;
  cwd: string;
  warnings: string[];
  /** Swappable so the dialogs can be wired after agent construction. */
  onPermissionRef: { current: OnPermission };
  onQuestionRef: { current: AskUser };
  policy: PermissionPolicy;
  customCommands: CustomCommand[];
  resolveModelFn: (id: string) => LanguageModel;
  config: AerinConfig;
  /** Set when startup could not resolve a model; forces the picker open first. */
  modelUnavailable?: string;
  /** Emits "wheel" (+1 down / -1 up) from the terminal mouse — set by run.tsx. */
  mouse?: import("node:events").EventEmitter;
}

/**
 * Ink rendering rules baked in here:
 * - Full-screen app on the alternate screen buffer (opencode-style): a fixed
 *   height/width root, a pinned header, a flex-grown transcript viewport with
 *   overflow hidden + justifyContent flex-end (newest content sticks to the
 *   bottom, old lines clip at the top), and a bottom section (dialogs, input,
 *   status) whose height the layout engine subtracts automatically. No
 *   <Static>, no spacer math — Yoga owns the geometry, so nothing drifts.
 * - Only the last VIEWPORT_ITEMS transcript items render (older ones are
 *   clipped anyway); that bounds per-frame work.
 * - Stream re-renders are batched to ~50ms, never per-token setState.
 * - Raw mode eats Ctrl+C, so double-Ctrl+C-to-exit is implemented explicitly.
 */

interface TranscriptItem {
  key: number;
  kind: "user" | "assistant" | "tool" | "tool-error" | "info" | "error";
  text: string;
}

/** Only this many trailing items are rendered — everything above is clipped anyway. */
const VIEWPORT_ITEMS = 150;

/** Picker rows: a Recent section first (opencode-style), then one group per provider. */
function buildPickerItems(
  models: DiscoveredModel[],
  recent: readonly string[],
  currentId: string,
): { label: string; value: string; header?: boolean }[] {
  const items: { label: string; value: string; header?: boolean }[] = [];
  const mark = (id: string): string => (id === currentId ? "  ✓ current" : "");

  const recentShown = recent.filter((id) => id === currentId || models.some((m) => m.id === id));
  if (recentShown.length > 0) {
    items.push({ label: "Recent", value: "__header_recent", header: true });
    for (const id of recentShown) {
      const m = models.find((mm) => mm.id === id);
      items.push({ label: (m ? formatModelLabel(m) : id) + mark(id), value: id });
    }
  }

  const inRecent = new Set(recentShown);
  let lastProvider = "";
  for (const m of models) {
    if (inRecent.has(m.id)) continue; // already shown under Recent
    if (m.provider !== lastProvider) {
      lastProvider = m.provider;
      items.push({
        label: PROVIDERS[m.provider]?.name ?? catalogEntry(m.provider)?.name ?? m.provider,
        value: `__header_${m.provider}`,
        header: true,
      });
    }
    items.push({ label: formatModelLabel(m, { stripProvider: true }) + mark(m.id), value: m.id });
  }
  return items;
}

type ConnectState =
  | { step: "pick" }
  | { step: "key"; id: string; label: string; baseURL?: string }
  | { step: "custom-name" }
  | { step: "custom-url"; id: string }
  | { step: "custom-key"; id: string; baseURL: string };

interface PendingPermission {
  req: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
}

const SLASH_COMMANDS = [
  { name: "/model", description: "switch model — pick from a live list, or /model provider/id" },
  { name: "/plan", description: "toggle plan mode — read-only exploration, agent presents a plan" },
  { name: "/undo", description: "revert the file changes of the last turn" },
  { name: "/connect", description: "connect a provider — catalog of 14 + custom endpoints" },
  { name: "/compact", description: "summarize the conversation to free context" },
  { name: "/clear", description: "clear conversation history" },
  { name: "/resume", description: "resume a previous conversation in this directory" },
  { name: "/help", description: "show commands and keys" },
  { name: "/exit", description: "quit aerin" },
] as const;

/** ANSI Shadow wordmark shown in the startup banner (37 cols × 6 rows). */
const LOGO = [
  " █████╗ ███████╗██████╗ ██╗███╗   ██╗",
  "██╔══██╗██╔════╝██╔══██╗██║████╗  ██║",
  "███████║█████╗  ██████╔╝██║██╔██╗ ██║",
  "██╔══██║██╔══╝  ██╔══██╗██║██║╚██╗██║",
  "██║  ██║███████╗██║  ██║██║██║ ╚████║",
  "╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝",
] as const;
const MIN_LOGO_COLUMNS = 42;

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

/** "~" for home, middle-ellipsis for long paths — keeps the header tidy. */
function shortenPath(p: string, max = 45): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  let out = home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  if (out.length > max) out = out.slice(0, Math.floor(max / 2) - 1) + "…" + out.slice(-Math.floor(max / 2));
  return out;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1e3).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function App(props: { setup: TuiSetup; initialPrompt?: string }): React.ReactElement {
  const { setup } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Terminal geometry — the root Box is sized to it and Yoga does the rest.
  const [size, setSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
  useEffect(() => {
    const onResize = (): void => setSize({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);
  const showLogo = size.columns >= MIN_LOGO_COLUMNS;
  // One row short of the terminal: at full height Ink switches to a
  // clear-terminal-per-frame fullscreen path, which visibly flickers on every
  // keystroke. One spare row keeps it on the incremental line-diff path.
  const usableRows = Math.max(10, size.rows - 1);

  const [items, setItems] = useState<TranscriptItem[]>(() =>
    setup.warnings.map((w, i) => ({ key: i, kind: "error" as const, text: `warning: ${w}` })),
  );
  const [streaming, setStreaming] = useState("");
  const [working, setWorking] = useState(false);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [denyReasonMode, setDenyReasonMode] = useState(false);
  const [modelPicker, setModelPicker] = useState<"loading" | DiscoveredModel[] | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionSummary[] | null>(null);
  const [helpMenu, setHelpMenu] = useState(false);
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [question, setQuestion] = useState<{
    q: string;
    options: string[];
    resolve: (answer: string) => void;
  } | null>(null);
  const [questionOther, setQuestionOther] = useState(false);
  const [mode, setMode] = useState<PermissionMode>("manual");
  const planMode = mode === "plan";
  const [exitArmed, setExitArmed] = useState(false);
  const [stats, setStats] = useState({ inTok: 0, outTok: 0, cost: 0 });
  const [modelId, setModelId] = useState(setup.modelId);
  const [recentModels, setRecentModels] = useState<string[]>(setup.config.recentModels ?? []);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0); // lines scrolled back from the live bottom
  const [queued, setQueued] = useState<string[]>([]); // messages typed while the agent was working
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
  const turnStartRef = useRef(0);

  const pushItem = useCallback((kind: TranscriptItem["kind"], text: string) => {
    setScrollOffset(0); // new content — snap back to following the bottom
    setItems((prev) => [...prev, { key: nextKey.current++, kind, text }]);
  }, []);

  // Workspace file list for @-mention completion; best effort, loaded once.
  useEffect(() => {
    void (async () => {
      try {
        const fg = (await import("fast-glob")).default;
        const files = await fg(["**/*"], {
          cwd: setup.cwd,
          onlyFiles: true,
          dot: false,
          followSymbolicLinks: false,
          suppressErrors: true,
          deep: 8,
          ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"],
        });
        setWorkspaceFiles(files.slice(0, 5000).sort());
      } catch {
        // no completion — @mentions still expand on submit
      }
    })();
  }, [setup.cwd]);

  // Startup update check; silent unless a newer version exists.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("https://registry.npmjs.org/aerin-agent/latest", {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return;
        const latest = ((await res.json()) as { version?: string }).version;
        if (latest && latest !== VERSION && VERSION !== "0.0.0") {
          pushItem("info", `(update available: v${latest} — run "aerin update")`);
        }
      } catch {
        // offline — never bother the user
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flat line buffer of the transcript — the unit of scrolling. Blank lines
  // reproduce the item margins so the scrolled view matches the live view.
  const [viewportH, setViewportH] = useState(10);
  const flatLines = React.useMemo(() => {
    const lines: { key: string; kind: TranscriptItem["kind"]; text: string }[] = [];
    for (const item of items) {
      item.text.split("\n").forEach((line, i) => {
        lines.push({
          key: `${item.key}:${i}`,
          kind: item.kind,
          text: item.kind === "user" && i === 0 ? `❯ ${line}` : line,
        });
      });
      if (item.kind === "assistant" || item.kind === "user") {
        lines.push({ key: `${item.key}:m`, kind: "info", text: "" });
      }
    }
    return lines;
  }, [items]);
  const flatLinesRef = useRef(flatLines);
  flatLinesRef.current = flatLines;
  const viewportHRef = useRef(viewportH);
  viewportHRef.current = viewportH;

  const scrollBy = useCallback((deltaLines: number) => {
    setScrollOffset((o) => {
      const max = Math.max(0, flatLinesRef.current.length - Math.max(4, viewportHRef.current));
      return Math.min(max, Math.max(0, o + deltaLines));
    });
  }, []);

  // Mouse wheel scrolls the transcript by lines, three per notch.
  useEffect(() => {
    const m = setup.mouse;
    if (!m) return;
    const onWheel = (dir: number): void => scrollBy(dir < 0 ? 3 : -3);
    m.on("wheel", onWheel);
    return () => {
      m.off("wheel", onWheel);
    };
  }, [setup.mouse, scrollBy]);

  // Wire the agent's permission and question callbacks to the dialogs.
  useEffect(() => {
    setup.onPermissionRef.current = (req) =>
      new Promise<PermissionDecision>((resolve) => setPermission({ req, resolve }));
    setup.onQuestionRef.current = (q, options) =>
      new Promise<string>((resolve) => setQuestion({ q, options, resolve }));
  }, [setup]);

  const flushStream = useCallback(() => {
    flushTimer.current = null;
    // Render markdown live while streaming — partial constructs (an unclosed
    // code fence, a half-typed **bold) degrade gracefully in marked-terminal.
    setStreaming(withDot(renderMarkdown(streamBuf.current)));
  }, []);

  const runTurn = useCallback(
    async (prompt: string, display?: string) => {
      workingRef.current = true;
      turnStartRef.current = Date.now();
      setWorking(true);
      const dirName = setup.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "aerin";
      setTerminalTitle(`✶ ${(display ?? prompt).replace(/\s+/g, " ").slice(0, 40)} — aerin`);
      pushItem("user", redactSecrets(display ?? prompt));
      // @path tokens attach the named files to the prompt (display stays clean).
      const expanded = await expandMentions(prompt, setup.cwd).catch(() => prompt);
      try {
        for await (const event of setup.agent.send(expanded)) {
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
            case "todo-update":
              setTodos(event.items);
              break;
            case "retry":
              pushItem(
                "info",
                `(provider error — retrying, attempt ${event.attempt}/${event.maxAttempts}: ${event.message.slice(0, 80)})`,
              );
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
        // An aborted/errored turn never reaches message-end — flush what
        // streamed so it is not lost, and never leaks into the next turn.
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = null;
        if (reasoningTimer.current) clearTimeout(reasoningTimer.current);
        reasoningTimer.current = null;
        if (streamBuf.current.trim()) pushItem("assistant", withDot(renderMarkdown(streamBuf.current)));
        streamBuf.current = "";
        setStreaming("");
        settleDialogs();
        setSubagents(new Map()); // clear stragglers on abort/error
        setTerminalTitle(`✦ aerin — ${dirName}`);
      }
      // Drain the queue: a message starts a turn (whose finally drains the
      // next); a command runs inline and must keep draining itself.
      setQueued(function drainStep(q): string[] {
        const [next, ...rest] = q;
        if (next !== undefined) {
          setTimeout(() => {
            if (next.startsWith("/")) {
              runCommand(next);
              setQueued(drainStep); // commands don't start turns — keep going
            } else {
              void runTurn(next);
            }
          }, 0);
        }
        return rest;
      });
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
      setCtxTokens(setup.agent.estimateContextTokens());
    },
    [setup, pushItem, replayHistory],
  );

  const openModelPicker = useCallback(async (): Promise<void> => {
    setModelPicker("loading");
    const { models, warnings } = await discoverModels(setup.config);
    for (const w of warnings) pushItem("error", w);
    if (models.length > 0) {
      setModelPicker(models);
    } else if (providersWithKeys(setup.config).length === 0) {
      // Nothing connected at all — the fix is a provider, not a model list.
      setModelPicker(null);
      pushItem("info", "(no providers connected yet — pick one to connect first)");
      setConnect({ step: "pick" });
    } else if (Object.keys(allKnownModels()).length > 0) {
      // Provider lists unreachable (offline?) — fall back to the models.dev
      // cache for the providers that have keys.
      const connected = new Set(providersWithKeys(setup.config));
      const cached = Object.entries(allKnownModels())
        .filter(([id]) => connected.has(id.split("/")[0] ?? ""))
        .map(([id, info]) => ({
          id,
          provider: id.split("/")[0] ?? "",
          contextWindow: info.contextWindow,
          ...(info.inputPerMTok !== undefined ? { inputPerMTok: info.inputPerMTok } : {}),
          ...(info.outputPerMTok !== undefined ? { outputPerMTok: info.outputPerMTok } : {}),
        }));
      if (cached.length > 0) {
        pushItem("info", "(provider lists unreachable — showing cached registry data)");
        setModelPicker(cached);
      } else {
        pushItem("error", "No model lists reachable. Type /model provider/model-id directly.");
        setModelPicker(null);
      }
    } else {
      pushItem("error", "No model lists reachable and no cached registry yet. Type /model provider/model-id directly.");
      setModelPicker(null);
    }
  }, [setup, pushItem]);

  const saveConnection = useCallback(
    async (id: string, key: string, baseURL?: string): Promise<void> => {
      // A key whose format belongs to another provider is refused outright.
      const looks = key ? keyLooksLike(key) : undefined;
      if (looks && looks !== id) {
        pushItem(
          "error",
          `✗ that looks like a ${looks} key (${key.slice(0, 7)}…), not a ${id} key — nothing saved. Run /connect ${looks} instead.`,
        );
        return;
      }
      try {
        await persistProviderKey(id, key, baseURL);
        setup.config.providers = {
          ...setup.config.providers,
          [id]: {
            ...setup.config.providers?.[id],
            ...(key ? { apiKey: key } : {}),
            ...(baseURL ? { baseURL } : {}),
          },
        };
      } catch (err) {
        pushItem("error", err instanceof Error ? err.message : String(err));
        return;
      }
      // Validate the key RIGHT NOW — a wrong key must be loud, not a mystery later.
      pushItem("info", `(checking the ${id} key…)`);
      try {
        const models = await listProviderModels(id, setup.config);
        if (!models || models.length === 0) {
          pushItem(
            "error",
            `✗ ${id}: the key was saved but the provider returned no models — it may be the wrong provider's key. Re-run /connect ${id} with the right one.`,
          );
          return;
        }
        pushItem("info", `✓ ${id} key works — ${models.length} models available`);
        await openModelPicker();
      } catch (err) {
        pushItem(
          "error",
          `✗ ${id} REJECTED the key (${err instanceof Error ? err.message : err}). ` +
            `Did you paste a different provider's key? The key is saved but unusable — re-run /connect ${id}.`,
        );
      }
    },
    [setup, pushItem, openModelPicker],
  );

  const handleCommand = useCallback(
    async (line: string): Promise<void> => {
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "/help":
          setHelpMenu(true);
          return;
        case "/clear": {
          await setup.agent.clear();
          setItems([]); // fully dynamic viewport — emptying state empties the screen
          setCtxTokens(0);
          setTodos([]);
          return;
        }
        case "/undo": {
          const restored = await setup.agent.undo();
          const rel = restored.map((p) => (p.startsWith(setup.cwd) ? p.slice(setup.cwd.length + 1) : p));
          pushItem(
            "info",
            restored.length > 0
              ? `(reverted ${restored.length} file${restored.length === 1 ? "" : "s"}: ${rel.join(", ").slice(0, 120)})`
              : "(nothing to undo — no file changes recorded this session)",
          );
          return;
        }
        case "/connect": {
          const [prov, key] = arg.split(/\s+/);
          if (prov && key) {
            await saveConnection(prov, key, catalogEntry(prov)?.baseURL);
            return;
          }
          setConnect({ step: "pick" });
          return;
        }
        case "/plan": {
          const next: PermissionMode = setup.policy.inPlanMode ? "manual" : "plan";
          setup.policy.setMode(next);
          setMode(next);
          pushItem(
            "info",
            next === "plan"
              ? "(plan mode ON — write/execute tools are denied; the agent will explore and present a plan)"
              : "(plan mode OFF — the agent can make changes again)",
          );
          return;
        }
        case "/compact": {
          const before = setup.agent.history.length;
          if (before === 0) {
            pushItem("info", "(nothing to compact — history is empty)");
            return;
          }
          await setup.agent.compactNow();
          const after = setup.agent.history.length;
          const est = setup.agent.estimateContextTokens();
          setCtxTokens(est);
          pushItem(
            "info",
            after === before
              ? "(history is still small — nothing was summarized)"
              : `(compacted ${before} → ${after} messages, ~${fmtTokens(est)} tokens of context)`,
          );
          return;
        }
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
          await openModelPicker();
          return;
        }
        default: {
          const custom = setup.customCommands.find((c) => `/${c.name}` === cmd);
          if (custom) {
            void runTurn(renderCommand(custom, arg), `${cmd}${arg ? ` ${arg}` : ""}`);
            return;
          }
          pushItem("error", `Unknown command: ${cmd}. Try /help.`);
        }
      }
    },
    [setup, pushItem, exit, resumeSession, runTurn, openModelPicker, saveConnection],
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
        setRecentModels((prev) => [id, ...prev.filter((m) => m !== id)].slice(0, 5));
        void persistModelChoice(id).catch(() => {}); // sticky across sessions; best effort
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
      if (!line) return;
      setInputHistory((h) => (h[h.length - 1] === line ? h : [...h, line].slice(-100)));
      if (workingRef.current) {
        setQueued((q) => [...q, line]);
        pushItem("info", `(queued — sends when this turn finishes: ${line.slice(0, 60)})`);
        return;
      }
      if (line.startsWith("/")) {
        runCommand(line);
      } else {
        void runTurn(line);
      }
    },
    [runCommand, runTurn, pushItem],
  );

  // A pending dialog blocks the agent loop on an unresolved promise — resolve
  // it before aborting or the turn can never finish.
  const settleDialogs = useCallback(() => {
    setPermission((prev) => {
      prev?.resolve({ kind: "deny", reason: "Interrupted." });
      return null;
    });
    setQuestion((prev) => {
      prev?.resolve("");
      return null;
    });
    setQuestionOther(false);
  }, []);

  // Global keys: Esc interrupts; Shift+Tab cycles modes; PgUp/PgDn scroll; double Ctrl+C exits.
  useInput((input, key) => {
    if (key.tab && key.shift) {
      // manual → accept edits → plan → manual (Claude Code order)
      const next: PermissionMode = mode === "manual" ? "accept" : mode === "accept" ? "plan" : "manual";
      setup.policy.setMode(next);
      setMode(next);
      pushItem(
        "info",
        next === "manual"
          ? "(mode: manual — edits and commands ask)"
          : next === "accept"
            ? "(mode: accept edits — file changes auto-approved, commands still ask)"
            : "(mode: plan — read-only, the agent presents a plan)",
      );
      return;
    }
    if (key.pageUp) {
      scrollBy(Math.max(3, viewportHRef.current - 2));
      return;
    }
    if (key.pageDown) {
      scrollBy(-Math.max(3, viewportHRef.current - 2));
      return;
    }
    if (key.escape && workingRef.current) {
      settleDialogs();
      setup.agent.abort();
      return;
    }
    if (key.ctrl && input === "c") {
      if (workingRef.current) {
        settleDialogs();
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
      setCtxTokens(setup.agent.estimateContextTokens());
    }
    // With no usable model the startup warning already says to run /model;
    // keep the input active (auto-opening the picker would swallow typed
    // commands) and skip any initial prompt — the stub model can't run it.
    if (props.initialPrompt && !setup.modelUnavailable) void runTurn(props.initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The input stays visible and typable even while the agent works — messages
  // submitted mid-turn are queued and sent when the turn finishes. Only modal
  // dialogs take the input away.
  const inputActive = !permission && !modelPicker && !sessionPicker && !question && !helpMenu && !connect;

  const allCommands = [
    ...SLASH_COMMANDS,
    ...setup.customCommands.map((c) => ({ name: `/${c.name}`, description: c.description })),
  ];

  // Transcript alignment: content flows from the top (Claude Code-style) while
  // it fits; once it outgrows the viewport it bottom-aligns so the newest line
  // stays visible above the input and old lines clip at the top.
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const v = viewportRef.current ? measureElement(viewportRef.current).height : 0;
    const c = contentRef.current ? measureElement(contentRef.current).height : 0;
    const next = v > 0 && c > v;
    setOverflowing((prev) => (prev === next ? prev : next));
    if (v > 0) setViewportH((prev) => (prev === v ? prev : v));
  });

  return (
    <Box flexDirection="column" height={usableRows} width={size.columns}>
      {/* Pinned header — compact, no border box, divider underneath */}
      <Box flexDirection="column" flexShrink={0} paddingX={1}>
        {showLogo ? (
          LOGO.map((row, i) => (
            <Text key={i} bold color={C.accentBright}>
              {row}
            </Text>
          ))
        ) : (
          <Text color={C.accentBright} bold>
            ✦ Aerin
          </Text>
        )}
        <Text>
          <Text color={C.dim} dimColor>
            v{VERSION}
          </Text>
          <Text color={C.dim}> · </Text>
          <Text color={C.accent}>{modelId}</Text>
          <Text color={C.dim}> · {shortenPath(setup.cwd)}</Text>
        </Text>
        <Text color={C.dim} dimColor>
          {"─".repeat(Math.max(10, size.columns - 2))}
        </Text>
      </Box>

      {/* Transcript viewport: top-aligned while content fits; once it
          overflows, newest content sticks to the bottom and old lines clip
          away at the top. */}
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        overflowY="hidden"
        justifyContent={overflowing && scrollOffset === 0 ? "flex-end" : "flex-start"}
      >
        {scrollOffset > 0 ? (
          // History mode: an exact line window over the transcript.
          (() => {
            const end = Math.max(0, flatLines.length - scrollOffset);
            const start = Math.max(0, end - viewportH);
            return flatLines.slice(start, end).map((l) => (
              <Box key={l.key} flexShrink={0}>
                <Text
                  color={
                    l.kind === "user"
                      ? C.accent
                      : l.kind === "error" || l.kind === "tool-error"
                        ? C.error
                        : l.kind === "info"
                          ? C.dim
                          : undefined
                  }
                >
                  {l.text || " "}
                </Text>
              </Box>
            ));
          })()
        ) : (
        <Box ref={contentRef} flexDirection="column" flexShrink={0}>
        {items
          .slice(-VIEWPORT_ITEMS)
          .map((item) => (
          <Box
            key={item.key}
            marginBottom={item.kind === "assistant" || item.kind === "user" ? 1 : 0}
            flexShrink={0}
          >
            <Text
              color={
                item.kind === "user"
                  ? C.accent
                  : item.kind === "error" || item.kind === "tool-error"
                    ? C.error
                    : item.kind === "info"
                      ? C.dim
                      : undefined
              }
            >
              {item.kind === "user" ? `❯ ${item.text}` : item.text}
            </Text>
          </Box>
        ))}
      {streaming ? (
        <Box flexShrink={0}>
          <Text>{streaming}</Text>
        </Box>
      ) : null}
      {thinking && reasoningTail ? (
        <Box flexDirection="column" marginBottom={0}>
          <Text color={C.dim} dimColor>
            {reasoningTail}
          </Text>
        </Box>
      ) : null}
      {subagents.size > 0 ? (
        <Box flexDirection="column">
          {[...subagents.entries()].map(([id, s]) => (
            <Text key={id} color={C.dim}>
              {"  "}◐ {s.description} — {s.toolCalls} tools · {s.lastTool ?? "starting"}
            </Text>
          ))}
        </Box>
      ) : null}
      {todos.length > 0 ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.dim} paddingX={1} alignSelf="flex-start">
          {todos.map((t, i) => (
            <Text key={i} color={t.status === "done" ? C.ok : t.status === "active" ? C.accent : C.dim}>
              {t.status === "done" ? "☑" : t.status === "active" ? "▸" : "☐"} {t.text}
            </Text>
          ))}
        </Box>
      ) : null}
      {working && !permission && !question ? (
        <Box flexShrink={0}>
          <Spinner
            label={thinking ? "thinking — Esc to interrupt" : "working — Esc to interrupt"}
            since={turnStartRef.current}
          />
        </Box>
      ) : null}
        </Box>
        )}
      </Box>

      {/* Bottom section: dialogs, input, status — pinned by layout. */}
      <Box flexDirection="column" flexShrink={0}>
      {permission && !denyReasonMode ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.warn} paddingX={1}>
          <Text color={C.warn}>Permission: {permission.req.summary}</Text>
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
        <Box borderStyle="round" borderColor={C.error} paddingX={1}>
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

      {question && !questionOther ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>? {question.q}</Text>
          <SelectList
            active={true}
            items={[
              ...question.options.map((o) => ({ label: o, value: o })),
              { label: "✎ type a different answer", value: "__other__" },
            ]}
            onSelect={(v) => {
              if (v === "__other__") {
                setQuestionOther(true);
              } else {
                question.resolve(v);
                setQuestion(null);
              }
            }}
          />
        </Box>
      ) : null}

      {question && questionOther ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt="answer: "
            active={true}
            onSubmit={(answer) => {
              question.resolve(answer.trim());
              setQuestion(null);
              setQuestionOther(false);
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "pick" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>Connect a provider — type to filter, Enter to pick, Esc to cancel</Text>
          <FilterSelect
            active={true}
            items={[
              ...PROVIDER_CATALOG.map((e) => ({
                label: `${e.name}${resolveApiKey(e.id, setup.config) ? "  ✓ connected" : ""}`,
                value: e.id,
              })),
              { label: "Custom OpenAI-compatible endpoint…", value: "__custom__" },
            ]}
            onCancel={() => setConnect(null)}
            onSelect={(v) => {
              if (v === "__custom__") {
                setConnect({ step: "custom-name" });
                return;
              }
              const entry = catalogEntry(v);
              if (!entry) return setConnect(null);
              if (!entry.needsKey) {
                setConnect(null);
                void saveConnection(entry.id, "", entry.baseURL);
                return;
              }
              setConnect({
                step: "key",
                id: entry.id,
                label: entry.name,
                ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
              });
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "key" ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt={`${connect.label} API key (Enter empty to cancel): `}
            active={true}
            onSubmit={(raw) => {
              const key = raw.trim();
              const { id, baseURL } = connect;
              setConnect(null);
              if (!key) return pushItem("info", "(connect cancelled)");
              void saveConnection(id, key, baseURL);
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "custom-name" ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt="provider name, lowercase (Enter empty to cancel): "
            active={true}
            onSubmit={(raw) => {
              const id = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
              if (!id) {
                setConnect(null);
                return pushItem("info", "(connect cancelled)");
              }
              setConnect({ step: "custom-url", id });
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "custom-url" ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt={`base URL for ${connect.id} (e.g. https://host/v1): `}
            active={true}
            onSubmit={(raw) => {
              const baseURL = raw.trim();
              const { id } = connect;
              if (!/^https?:\/\//.test(baseURL)) {
                setConnect(null);
                return pushItem("info", "(connect cancelled — base URL must start with http)");
              }
              setConnect({ step: "custom-key", id, baseURL });
            }}
          />
        </Box>
      ) : null}

      {connect?.step === "custom-key" ? (
        <Box borderStyle="round" borderColor={C.accent} paddingX={1}>
          <LineInput
            prompt={`${connect.id} API key (Enter empty if none, e.g. local): `}
            active={true}
            onSubmit={(raw) => {
              const { id, baseURL } = connect;
              setConnect(null);
              void saveConnection(id, raw.trim(), baseURL);
            }}
          />
        </Box>
      ) : null}

      {helpMenu ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>Commands — ↑/↓ to choose, Enter to run, Esc to close</Text>
          <FilterSelect
            active={true}
            items={allCommands.map((c) => ({
              label: `${c.name.padEnd(9)} ${c.description}`,
              value: c.name,
            }))}
            onCancel={() => setHelpMenu(false)}
            onSelect={(name) => {
              setHelpMenu(false);
              if (name !== "/help") runCommand(name);
            }}
          />
          <Text color={C.dim}>
            Esc interrupt/clear · Esc Esc edit last · Shift+Tab cycle manual/accept/plan · Ctrl+C twice exit
          </Text>
        </Box>
      ) : null}

      {modelPicker === "loading" ? (
        <Text color={C.dim}>… fetching available models from your providers</Text>
      ) : null}

      {modelPicker && modelPicker !== "loading" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>Pick a model (current: {modelId}) — type to filter, Esc to cancel</Text>
          <FilterSelect
            active={true}
            items={buildPickerItems(modelPicker, recentModels, modelId)}
            onCancel={() => setModelPicker(null)}
            onSelect={(id) => {
              setModelPicker(null);
              switchModel(id);
            }}
          />
        </Box>
      ) : null}

      {sessionPicker ? (
        <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1}>
          <Text color={C.accent}>Resume a conversation — type to filter, Esc to cancel</Text>
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
        <Box
          borderStyle="round"
          borderColor={planMode ? C.magenta : mode === "accept" ? C.ok : working ? C.warn : C.accent}
          paddingX={1}
        >
          <LineInput
            prompt="❯ "
            active={inputActive}
            onSubmit={onSubmit}
            history={inputHistory}
            commands={allCommands}
            files={workspaceFiles}
            escActive={!working}
            recallLast={() => inputHistory[inputHistory.length - 1]}
            placeholder={
              working
                ? "type your next message — it sends when this turn finishes"
                : "ask anything · @file to attach · / for commands"
            }
          />
        </Box>
      ) : null}

      <Box paddingX={1}>
        <Text>
          <Text color={C.accent}>{modelId.split("/").slice(-1)[0]}</Text>
          {ctxTokens > 0 ? (
            <Text
              color={
                ctxTokens / modelInfo(modelId).contextWindow > 0.8
                  ? C.error
                  : ctxTokens / modelInfo(modelId).contextWindow > 0.5
                    ? C.warn
                    : C.dim
              }
            >
              {` · ctx ${Math.round((ctxTokens / modelInfo(modelId).contextWindow) * 100)}%`}
            </Text>
          ) : null}
          <Text color={C.dim}>
            {" · "}
            {fmtTokens(stats.inTok)}↑ {fmtTokens(stats.outTok)}↓
            {stats.cost > 0
              ? ` · $${stats.cost.toFixed(stats.cost < 0.1 ? 4 : 2)}${catalogEntry(modelId.split("/")[0] ?? "")?.freeTier ? " (free tier — not billed)" : ""}`
              : ""}
          </Text>
          {planMode ? <Text color={C.magenta}> · PLAN (shift+tab)</Text> : null}
          {mode === "accept" ? <Text color={C.ok}> · ⏵⏵ accept edits (shift+tab)</Text> : null}
          {queued.length > 0 ? <Text color={C.warn}> · {queued.length} queued</Text> : null}
          {scrollOffset > 0 ? <Text color={C.warn}> · ↑ scrolled (PgDn)</Text> : null}
          {exitArmed ? <Text color={C.error}> · Ctrl+C again to exit</Text> : null}
        </Text>
      </Box>
      </Box>
    </Box>
  );
}

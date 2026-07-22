import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { LanguageModel } from "ai";
import type { Agent } from "../core/agent.js";
import type { OnPermission, PermissionDecision, PermissionRequest } from "../core/events.js";
import type { AerinConfig } from "../config/config.js";
import { MODEL_TABLE } from "../providers/models.js";
import { discoverModels } from "../providers/list-models.js";
import { SessionStore } from "../session/store.js";
import { renderMarkdown } from "./markdown.js";
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
  kind: "user" | "assistant" | "tool" | "tool-error" | "info" | "error";
  text: string;
}

interface PendingPermission {
  req: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
}

const HELP_TEXT = `Commands: /help /clear /compact /model [provider/id] /sessions /exit
Esc interrupts a running turn. Ctrl+C twice exits.`;

export function App(props: { setup: TuiSetup; initialPrompt?: string }): React.ReactElement {
  const { setup } = props;
  const { exit } = useApp();

  const [items, setItems] = useState<TranscriptItem[]>(() => [
    { key: 0, kind: "info", text: `aerin ${setup.modelId} — ${setup.cwd}\n${HELP_TEXT}` },
    ...setup.warnings.map((w, i) => ({ key: i + 1, kind: "error" as const, text: `warning: ${w}` })),
  ]);
  const [streaming, setStreaming] = useState("");
  const [working, setWorking] = useState(false);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [denyReasonMode, setDenyReasonMode] = useState(false);
  const [modelPicker, setModelPicker] = useState<"loading" | { id: string }[] | null>(null);
  const [exitArmed, setExitArmed] = useState(false);
  const [stats, setStats] = useState({ inTok: 0, outTok: 0, cost: 0 });
  const [modelId, setModelId] = useState(setup.modelId);
  const [inputHistory, setInputHistory] = useState<string[]>([]);

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
    setStreaming(streamBuf.current);
  }, []);

  const runTurn = useCallback(
    async (prompt: string) => {
      workingRef.current = true;
      setWorking(true);
      pushItem("user", prompt);
      try {
        for await (const event of setup.agent.send(prompt)) {
          switch (event.type) {
            case "text-delta":
            case "reasoning-delta": {
              if (event.type === "text-delta") {
                streamBuf.current += event.text;
                if (!flushTimer.current) flushTimer.current = setTimeout(flushStream, 50);
              }
              break;
            }
            case "message-end": {
              if (flushTimer.current) clearTimeout(flushTimer.current);
              flushTimer.current = null;
              const text = streamBuf.current;
              streamBuf.current = "";
              setStreaming("");
              if (text.trim()) pushItem("assistant", renderMarkdown(text));
              break;
            }
            case "tool-call":
              pushItem("tool", `⏺ ${event.summary}`);
              break;
            case "tool-result": {
              const first = (event.output.split("\n")[0] ?? "").slice(0, 100);
              pushItem(event.isError ? "tool-error" : "info", `  ⎿ ${event.isError ? "✗ " : ""}${first}`);
              break;
            }
            case "compaction":
              pushItem("info", `[compacting context — was ${event.preTokens} tokens]`);
              break;
            case "usage":
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
        setPermission(null);
      }
    },
    [setup, pushItem, flushStream],
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
          await setup.agent.compactNow();
          pushItem("info", "(compacted)");
          return;
        case "/exit":
        case "/quit":
          exit();
          return;
        case "/sessions": {
          const sessions = await SessionStore.list(setup.cwd);
          pushItem(
            "info",
            sessions.length
              ? sessions.slice(0, 15).map((s) => `${s.id}  ${s.createdAt}  ${s.model}`).join("\n")
              : "(no sessions)",
          );
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
            setModelPicker(models.map((m) => ({ id: m.id })));
          } else {
            // No provider reachable — fall back to the known-model metadata table.
            pushItem("info", "No provider model lists reachable — showing known models. You can always type /model provider/any-id directly.");
            setModelPicker(Object.keys(MODEL_TABLE).map((id) => ({ id })));
          }
          return;
        }
        default:
          pushItem("error", `Unknown command: ${cmd}. Try /help.`);
      }
    },
    [setup, pushItem, exit],
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
        void handleCommand(line);
      } else {
        void runTurn(line);
      }
    },
    [handleCommand, runTurn],
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
    if (props.initialPrompt) void runTurn(props.initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputActive = !working && !permission && !modelPicker;

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => (
          <Box key={item.key} marginBottom={item.kind === "assistant" || item.kind === "user" ? 1 : 0}>
            <Text
              color={
                item.kind === "user"
                  ? "cyan"
                  : item.kind === "error" || item.kind === "tool-error"
                    ? "red"
                    : item.kind === "tool"
                      ? "yellow"
                      : item.kind === "info"
                        ? "gray"
                        : undefined
              }
            >
              {item.kind === "user" ? `> ${item.text}` : item.text}
            </Text>
          </Box>
        )}
      </Static>

      {streaming ? <Text>{streaming}</Text> : null}
      {working && !permission ? <Spinner label="working — Esc to interrupt" /> : null}

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
            items={modelPicker.map((m) => ({ label: m.id, value: m.id }))}
            onCancel={() => setModelPicker(null)}
            onSelect={(id) => {
              setModelPicker(null);
              switchModel(id);
            }}
          />
        </Box>
      ) : null}

      {inputActive ? (
        <LineInput prompt="> " active={inputActive} onSubmit={onSubmit} history={inputHistory} />
      ) : null}

      <Box>
        <Text color="gray">
          {modelId} · {stats.inTok} in / {stats.outTok} out
          {stats.cost > 0 ? ` · ~$${stats.cost.toFixed(4)}` : ""}
          {exitArmed ? " · press Ctrl+C again to exit" : ""}
        </Text>
      </Box>
    </Box>
  );
}

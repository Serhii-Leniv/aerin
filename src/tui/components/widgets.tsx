import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

/**
 * Single-line text input with cursor movement (←/→/Home/End), editing
 * (backspace, Ctrl+U clear, Ctrl+W delete word), and Up/Down history recall.
 * Pasted newlines are flattened to spaces so a multi-line paste becomes one
 * prompt instead of firing a submit per line.
 */
export function LineInput(props: {
  prompt: string;
  onSubmit: (value: string) => void;
  active: boolean;
  history?: readonly string[];
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [histIdx, setHistIdx] = useState(-1); // -1 = editing a fresh line
  const [draft, setDraft] = useState("");

  const set = (v: string, c: number) => {
    setValue(v);
    setCursor(Math.max(0, Math.min(c, v.length)));
  };

  useInput(
    (input, key) => {
      const history = props.history ?? [];
      if (key.return) {
        const v = value;
        set("", 0);
        setHistIdx(-1);
        setDraft("");
        props.onSubmit(v);
        return;
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      if (key.upArrow) {
        if (history.length === 0) return;
        if (histIdx === -1) setDraft(value);
        const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(next);
        set(history[next] ?? "", (history[next] ?? "").length);
        return;
      }
      if (key.downArrow) {
        if (histIdx === -1) return;
        if (histIdx >= history.length - 1) {
          setHistIdx(-1);
          set(draft, draft.length);
        } else {
          const next = histIdx + 1;
          setHistIdx(next);
          set(history[next] ?? "", (history[next] ?? "").length);
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }
      if (key.ctrl) {
        if (input === "a") return setCursor(0);
        if (input === "e") return setCursor(value.length);
        if (input === "u") return set("", 0);
        if (input === "w") {
          const head = value.slice(0, cursor).replace(/\S+\s*$/, "");
          set(head + value.slice(cursor), head.length);
          return;
        }
        return;
      }
      if (input && !key.meta) {
        const clean = input.replace(/\r?\n/g, " "); // flatten pasted newlines
        set(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
        setHistIdx(-1);
      }
    },
    { isActive: props.active },
  );

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);

  return (
    <Box>
      <Text color="cyan">{props.prompt}</Text>
      <Text>{before}</Text>
      {props.active ? <Text inverse>{at}</Text> : <Text>{at}</Text>}
      <Text>{after}</Text>
    </Box>
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner(props: { label: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color="gray">
      {SPINNER_FRAMES[frame]} {props.label}
    </Text>
  );
}

/** Unified-diff renderer: green additions, red deletions, cyan hunk headers. */
export function DiffText(props: { diff: string; maxLines?: number }): React.ReactElement {
  const lines = props.diff.split("\n").slice(0, props.maxLines ?? 30);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text
          key={i}
          color={
            line.startsWith("+") && !line.startsWith("+++")
              ? "green"
              : line.startsWith("-") && !line.startsWith("---")
                ? "red"
                : line.startsWith("@@")
                  ? "cyan"
                  : "gray"
          }
        >
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}

export interface SelectItem {
  label: string;
  value: string;
  /** Non-selectable section header (e.g. a provider name). */
  header?: boolean;
}

const FILTER_VISIBLE_ROWS = 14;

/**
 * Filterable select with section headers: type to narrow, arrows move over
 * selectable rows only, Enter picks, Esc cancels. Headers survive filtering
 * only while they still have visible children. A sliding window keeps
 * hundreds of items (e.g. OpenRouter's model list) usable in a terminal.
 */
export function FilterSelect(props: {
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  active: boolean;
  placeholder?: string;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0); // index into the selectable subset

  const q = query.toLowerCase();
  const rows: SelectItem[] = [];
  for (let i = 0; i < props.items.length; i++) {
    const it = props.items[i];
    if (!it) continue;
    if (it.header) {
      for (let j = i + 1; j < props.items.length; j++) {
        const child = props.items[j];
        if (!child || child.header) break;
        if (!q || child.label.toLowerCase().includes(q)) {
          rows.push(it);
          break;
        }
      }
    } else if (!q || it.label.toLowerCase().includes(q)) {
      rows.push(it);
    }
  }
  const selectableRowIdx = rows.flatMap((r, i) => (r.header ? [] : [i]));
  const clampedSel = Math.min(sel, Math.max(0, selectableRowIdx.length - 1));
  const currentRow = selectableRowIdx[clampedSel] ?? -1;

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onCancel();
        return;
      }
      if (key.return) {
        const item = rows[currentRow];
        if (item) props.onSelect(item.value);
        return;
      }
      if (key.upArrow) return setSel(Math.max(0, clampedSel - 1));
      if (key.downArrow) return setSel(Math.min(selectableRowIdx.length - 1, clampedSel + 1));
      if (key.backspace || key.delete) {
        setQuery((v) => v.slice(0, -1));
        setSel(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((v) => v + input.replace(/\r?\n/g, ""));
        setSel(0);
      }
    },
    { isActive: props.active },
  );

  const anchor = currentRow >= 0 ? currentRow : 0;
  const windowStart = Math.max(0, Math.min(anchor - 6, rows.length - FILTER_VISIBLE_ROWS));
  const visible = rows.slice(windowStart, windowStart + FILTER_VISIBLE_ROWS);
  const selectableCount = selectableRowIdx.length;
  const totalSelectable = props.items.filter((i) => !i.header).length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">filter: </Text>
        <Text>{query || (props.placeholder ?? "type to filter…")}</Text>
        <Text color="gray"> ({selectableCount}/{totalSelectable})</Text>
      </Box>
      {visible.map((item, i) => {
        const absolute = windowStart + i;
        if (item.header) {
          return (
            <Text key={`h-${item.value}`} bold color="magenta">
              {item.label}
            </Text>
          );
        }
        return (
          <Text key={item.value} color={absolute === currentRow ? "cyan" : undefined}>
            {absolute === currentRow ? "❯ " : "  "}
            {item.label}
          </Text>
        );
      })}
      {selectableCount === 0 ? <Text color="gray">  (no matches — Esc to cancel)</Text> : null}
    </Box>
  );
}

/** Minimal arrow-key select list. */
export function SelectList(props: {
  items: SelectItem[];
  onSelect: (value: string) => void;
  active: boolean;
}): React.ReactElement {
  const [index, setIndex] = useState(0);
  useInput(
    (_input, key) => {
      if (key.upArrow) setIndex((i) => (i - 1 + props.items.length) % props.items.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % props.items.length);
      else if (key.return) {
        const item = props.items[index];
        if (item) props.onSelect(item.value);
      }
    },
    { isActive: props.active },
  );
  return (
    <Box flexDirection="column">
      {props.items.map((item, i) => (
        <Text key={item.value} color={i === index ? "cyan" : undefined}>
          {i === index ? "❯ " : "  "}
          {item.label}
        </Text>
      ))}
    </Box>
  );
}

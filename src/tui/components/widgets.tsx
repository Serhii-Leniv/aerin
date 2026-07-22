import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

/** Minimal single-line text input (chars + backspace + enter). */
export function LineInput(props: {
  prompt: string;
  onSubmit: (value: string) => void;
  active: boolean;
}): React.ReactElement {
  const [value, setValue] = useState("");
  useInput(
    (input, key) => {
      if (key.return) {
        const v = value;
        setValue("");
        props.onSubmit(v);
        return;
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setValue((v) => v + input);
      }
    },
    { isActive: props.active },
  );
  return (
    <Box>
      <Text color="cyan">{props.prompt}</Text>
      <Text>{value}</Text>
      {props.active ? <Text color="gray">▌</Text> : null}
    </Box>
  );
}

export interface SelectItem {
  label: string;
  value: string;
}

const FILTER_VISIBLE_ROWS = 12;

/**
 * Filterable select: type to narrow, arrows to move, Enter picks, Esc cancels.
 * Renders a sliding window so hundreds of items (e.g. OpenRouter's model
 * list) stay usable in a terminal.
 */
export function FilterSelect(props: {
  items: SelectItem[];
  onSelect: (value: string) => void;
  onCancel: () => void;
  active: boolean;
  placeholder?: string;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const q = query.toLowerCase();
  const filtered = q
    ? props.items.filter((i) => i.label.toLowerCase().includes(q))
    : props.items;
  const clampedIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onCancel();
        return;
      }
      if (key.return) {
        const item = filtered[clampedIndex];
        if (item) props.onSelect(item.value);
        return;
      }
      if (key.upArrow) {
        setIndex(Math.max(0, clampedIndex - 1));
        return;
      }
      if (key.downArrow) {
        setIndex(Math.min(filtered.length - 1, clampedIndex + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((v) => v.slice(0, -1));
        setIndex(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((v) => v + input);
        setIndex(0);
      }
    },
    { isActive: props.active },
  );

  const windowStart = Math.max(0, Math.min(clampedIndex - 5, filtered.length - FILTER_VISIBLE_ROWS));
  const visible = filtered.slice(windowStart, windowStart + FILTER_VISIBLE_ROWS);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">filter: </Text>
        <Text>{query || (props.placeholder ?? "type to filter…")}</Text>
        <Text color="gray"> ({filtered.length}/{props.items.length})</Text>
      </Box>
      {visible.map((item, i) => {
        const absolute = windowStart + i;
        return (
          <Text key={item.value} color={absolute === clampedIndex ? "cyan" : undefined}>
            {absolute === clampedIndex ? "❯ " : "  "}
            {item.label}
          </Text>
        );
      })}
      {filtered.length === 0 ? <Text color="gray">  (no matches — Esc to cancel)</Text> : null}
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

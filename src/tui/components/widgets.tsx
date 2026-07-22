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

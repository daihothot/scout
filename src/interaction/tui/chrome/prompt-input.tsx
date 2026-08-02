import React, { useRef, useState } from "react";
import { Box, Text, useCursor, useInput, usePaste } from "ink";
import { parseSgrMouseEvent } from "../activity-viewport.js";
import {
  tailByDisplayWidth,
  terminalDisplayWidth,
  truncateByDisplayWidth,
} from "../terminal-text.js";
import type { TuiWidths } from "../workspace-layout.js";
import {
  normalizePromptPaste,
  reducePromptInput,
} from "./prompt-input-state.js";

const INPUT_BORDER_WIDTH = 1;
const INPUT_PADDING_X = 1;
const INPUT_PROMPT = "› ";

export const PROMPT_INPUT_ROWS = 5;

export function PromptInput({
  active,
  appHeight,
  widths,
  cwd,
  onSubmit,
  onExit,
}: {
  active: boolean;
  appHeight: number;
  widths: TuiWidths;
  cwd: string;
  onSubmit: (value: string) => void;
  onExit: () => void;
}) {
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  const { setCursorPosition } = useCursor();
  const inputStartX = widths.rootPaddingX
    + INPUT_BORDER_WIDTH
    + INPUT_PADDING_X
    + terminalDisplayWidth(INPUT_PROMPT);
  const inputLineY = Math.max(0, appHeight - 3);
  const visibleValue = tailByDisplayWidth(value, widths.inputValueWidth);

  setCursorPosition(active
    ? {
      x: Math.min(
        widths.terminalWidth - 1,
        inputStartX + terminalDisplayWidth(visibleValue),
      ),
      y: inputLineY,
    }
    : undefined);

  const commitValue = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };
  const applyInput = (input: string) => {
    const transition = reducePromptInput(valueRef.current, input);
    commitValue(transition.value);
    for (const submitted of transition.submissions) onSubmit(submitted);
    if (transition.exitRequested) onExit();
  };

  useInput((input, key) => {
    if (key.return) {
      applyInput("\r");
      return;
    }
    if (key.backspace || key.delete) {
      applyInput("\u007f");
      return;
    }
    if (key.escape) {
      commitValue("");
      return;
    }
    if (key.ctrl && input === "u") {
      applyInput("\u0015");
      return;
    }
    if (
      input
      && !key.ctrl
      && !key.meta
      && !parseSgrMouseEvent(input)
    ) {
      applyInput(input);
    }
  }, { isActive: active });

  usePaste((input) => {
    const pasted = normalizePromptPaste(input);
    if (pasted.length > 0) commitValue(`${valueRef.current}${pasted}`);
  }, { isActive: active });

  const footer = `enter send · Tab tasks · Ctrl+C quit · cwd ${cwd}`;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box
        borderStyle="single"
        borderColor={active ? "cyan" : "gray"}
        paddingX={INPUT_PADDING_X}
        marginTop={1}
        width={widths.contentWidth}
        flexShrink={0}
      >
        <Text wrap="truncate-end">
          <Text color={active ? "cyan" : "gray"}>{INPUT_PROMPT}</Text>
          {visibleValue
            ? <Text>{visibleValue}</Text>
            : <Text dimColor>Ask Scout...</Text>}
        </Text>
      </Box>
      <Text dimColor>{truncateByDisplayWidth(footer, widths.contentWidth)}</Text>
    </Box>
  );
}

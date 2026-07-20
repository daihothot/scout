import React, { useState } from "react";
import { Box, Text, useCursor, useInput } from "ink";
import { parseSgrMouseEvent } from "../activity-viewport.js";
import {
  tailByDisplayWidth,
  terminalDisplayWidth,
  truncateByDisplayWidth,
} from "../terminal-text.js";
import type { TuiWidths } from "../workspace-layout.js";

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

  useInput((input, key) => {
    if (!active) return;
    if (key.return) {
      const submitted = value.trim();
      if (submitted === "/exit") {
        setValue("");
        onExit();
        return;
      }
      if (submitted.length > 0) onSubmit(submitted);
      setValue("");
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (key.escape) {
      setValue("");
      return;
    }
    if (
      input
      && !key.ctrl
      && !key.meta
      && !parseSgrMouseEvent(input)
      && !/[\u0000-\u001f\u007f]/.test(input)
    ) {
      setValue((current) => `${current}${input}`);
    }
  });

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

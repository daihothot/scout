import React, { useRef, useState } from "react";
import { Box, Text, useCursor, useInput, usePaste } from "ink";
import { parseSgrMouseEvent } from "../activity-viewport.js";
import { truncateByDisplayWidth } from "../terminal-text.js";
import type { TuiWidths } from "../workspace-layout.js";
import {
  normalizePromptPaste,
  reducePromptInput,
} from "./prompt-input-state.js";
import {
  PROMPT_INPUT_ROWS,
  resolvePromptInputLayout,
} from "./prompt-input-layout.js";

export { PROMPT_INPUT_ROWS };

const INPUT_PADDING_X = 1;
const INPUT_PROMPT = "› ";

/** Interactive prompt that translates terminal input into submit and exit callbacks. */
export function PromptInput({
  active,
  focused,
  promptTopY,
  widths,
  cwd,
  onSubmit,
  onExit,
  onFocus,
  onBlur,
}: {
  active: boolean;
  focused: boolean;
  promptTopY: number;
  widths: TuiWidths;
  cwd: string;
  onSubmit: (value: string) => void;
  onExit: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  const { setCursorPosition } = useCursor();
  // Keep the listener alive to activate on the first input; only focused owns
  // the native cursor and focused border state.
  const cursorActive = active && focused;
  const { visibleValue, cursorPosition } = resolvePromptInputLayout({
    active: cursorActive,
    promptTopY,
    terminalWidth: widths.terminalWidth,
    rootPaddingX: widths.rootPaddingX,
    inputValueWidth: widths.inputValueWidth,
    value,
  });

  // Ink applies this intent during its commit phase; undefined explicitly hides
  // the terminal cursor when the prompt is not the focused control.
  setCursorPosition(cursorPosition);

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
    const mouse = parseSgrMouseEvent(input);
    if (mouse) {
      const mouseX = mouse.x - 1;
      const mouseY = mouse.y - 1;
      const inputBorderTopY = Math.max(0, promptTopY) + 1;
      const insideInput = mouseX >= widths.rootPaddingX
        && mouseX < widths.rootPaddingX + widths.contentWidth
        && mouseY >= inputBorderTopY
        && mouseY < inputBorderTopY + 3;
      const isMousePress = !mouse.released && (mouse.button & (32 | 64)) === 0;
      const isPrimaryPress = !mouse.released
        && (mouse.button & 3) === 0
        && (mouse.button & (32 | 64)) === 0;
      if (isMousePress) {
        if (insideInput && isPrimaryPress) onFocus();
        if (!insideInput) onBlur();
      }
      return;
    }
    if (key.return) {
      onFocus();
      applyInput("\r");
      return;
    }
    if (key.backspace || key.delete) {
      onFocus();
      applyInput("\u007f");
      return;
    }
    if (key.escape) {
      onFocus();
      commitValue("");
      return;
    }
    if (key.ctrl && input === "u") {
      onFocus();
      applyInput("\u0015");
      return;
    }
    if (
      input
      && !key.ctrl
      && !key.meta
    ) {
      onFocus();
      applyInput(input);
    }
  }, { isActive: active });

  usePaste((input) => {
    const pasted = normalizePromptPaste(input);
    if (pasted.length > 0) {
      onFocus();
      commitValue(`${valueRef.current}${pasted}`);
    }
  }, { isActive: active });

  const footer = `enter send · Tab tasks · Ctrl+C quit · cwd ${cwd}`;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box
        borderStyle="single"
        borderColor={cursorActive ? "cyan" : "gray"}
        paddingX={INPUT_PADDING_X}
        marginTop={1}
        width={widths.contentWidth}
        flexShrink={0}
      >
        <Text wrap="truncate-end">
          <Text color={cursorActive ? "cyan" : "gray"}>{INPUT_PROMPT}</Text>
          {visibleValue
            ? <Text>{visibleValue}</Text>
            : <Text dimColor>Ask Scout...</Text>}
        </Text>
      </Box>
      <Text dimColor>{truncateByDisplayWidth(footer, widths.contentWidth)}</Text>
    </Box>
  );
}

import {
  tailByDisplayWidth,
  terminalDisplayWidth,
} from "../terminal-text.js";

const INPUT_BORDER_WIDTH = 1;
const INPUT_PADDING_X = 1;
const INPUT_PROMPT = "› ";

/** Fixed vertical budget reserved for the prompt and its footer. */
export const PROMPT_INPUT_ROWS = 5;

export interface PromptCursorPosition {
  x: number;
  y: number;
}

/** Inputs needed to place the terminal cursor at the end of the visible prompt. */
export interface PromptCursorLayoutInput {
  active: boolean;
  promptTopY: number;
  terminalWidth: number;
  rootPaddingX: number;
  inputValueWidth: number;
  value: string;
}

/** Resolves the prompt text and cursor position from one committed layout snapshot. */
export function resolvePromptInputLayout(input: PromptCursorLayoutInput): {
  visibleValue: string;
  cursorPosition: PromptCursorPosition | undefined;
} {
  const visibleValue = tailByDisplayWidth(input.value, input.inputValueWidth);
  if (!input.active) {
    return { visibleValue, cursorPosition: undefined };
  }

  const inputStartX = input.rootPaddingX
    + INPUT_BORDER_WIDTH
    + INPUT_PADDING_X
    + terminalDisplayWidth(INPUT_PROMPT);
  const inputTopY = Math.max(0, input.promptTopY);
  const inputLineY = inputTopY + 2;
  const cursorX = inputStartX + terminalDisplayWidth(visibleValue);

  return {
    visibleValue,
    cursorPosition: {
      x: Math.max(0, Math.min(input.terminalWidth - 1, cursorX)),
      y: inputLineY,
    },
  };
}

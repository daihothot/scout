const BACKSPACE = "\u0008";
const DELETE = "\u007f";
const KILL_LINE = "\u0015";

/** State transition produced by decoding one batch of terminal input. */
export interface PromptInputTransition {
  value: string;
  submissions: string[];
  exitRequested: boolean;
}

/** Applies control characters, submissions, and the /exit command to prompt state. */
export function reducePromptInput(
  current: string,
  input: string,
): PromptInputTransition {
  let value = current;
  const submissions: string[] = [];
  let exitRequested = false;

  const submit = () => {
    const submitted = value.trim();
    value = "";
    if (submitted.length === 0) return;
    if (submitted === "/exit") {
      exitRequested = true;
      return;
    }
    submissions.push(submitted);
  };

  for (const character of input) {
    if (character === KILL_LINE) {
      value = "";
      continue;
    }
    if (character === BACKSPACE || character === DELETE) {
      value = removeLastCodePoint(value);
      continue;
    }
    if (character === "\r" || character === "\n") {
      submit();
      continue;
    }
    if (character === "\t") {
      value += " ";
      continue;
    }
    if (/[\u0000-\u001f]/.test(character)) continue;
    value += character;
  }

  return { value, submissions, exitRequested };
}

/** Normalizes pasted line breaks and control characters into single-line prompt text. */
export function normalizePromptPaste(input: string): string {
  return input
    .replaceAll(/\r\n|[\r\n\t\u2028\u2029]/g, " ")
    .replaceAll(/[\u0000-\u001f\u007f]/g, "");
}

function removeLastCodePoint(value: string): string {
  const characters = [...value];
  characters.pop();
  return characters.join("");
}

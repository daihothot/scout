import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Text,
  useApp,
  useCursor,
  useInput,
  useWindowSize,
} from "ink";
import type { TuiState, TuiStore } from "./tui-store.js";

export interface ScoutTuiAppProps {
  store: TuiStore;
}

const ROOT_PADDING_X = 1;
const INPUT_BORDER_WIDTH = 1;
const INPUT_PADDING_X = 1;
const INPUT_PROMPT = "› ";
const MIN_APP_HEIGHT = 12;

export function ScoutTuiApp({ store }: ScoutTuiAppProps) {
  const [state, setState] = useState<TuiState>(() => store.snapshot());
  const [input, setInput] = useState("");
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const appHeight = Math.max(MIN_APP_HEIGHT, rows - 1);

  useEffect(() => store.subscribe(setState), [store]);

  useInput((value, key) => {
    if ((key.ctrl && value === "c") || value === "q") {
      void store.requestExit().finally(() => exit());
      return;
    }
    if (key.return) {
      const submitted = input.trim();
      if (submitted.length > 0) {
        store.submitInput(submitted);
      }
      setInput("");
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (key.escape) {
      setInput("");
      return;
    }
    if (value && !key.ctrl && !key.meta) {
      setInput((current) => `${current}${value}`);
    }
  });

  const recentLogs = useMemo(() => state.logs.slice(-12), [state.logs]);
  const recentProgress = useMemo(() => state.progress.slice(-5), [state.progress]);

  return (
    <Box flexDirection="column" height={appHeight} paddingX={ROOT_PADDING_X} overflow="hidden">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1} flexShrink={0}>
        <Text bold>Scout TUI</Text>
        <Text dimColor>  q/Ctrl+C exit  Enter submit</Text>
      </Box>

      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Box flexDirection="column" width="45%" borderStyle="single" borderColor="green" paddingX={1}>
          <Text bold>Tasks</Text>
          {state.tasks.length === 0
            ? <Text dimColor>No tasks yet.</Text>
            : state.tasks.map((task) => (
              <Text key={task.taskId}>
                <Text color={statusColor(task.status)}>{task.status ?? "unknown"}</Text>
                {" "}
                <Text>{task.taskId}</Text>
                {task.description ? <Text dimColor> {task.description}</Text> : null}
              </Text>
            ))}
        </Box>

        <Box flexDirection="column" width="55%" borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text bold>Progress</Text>
          {recentProgress.length === 0
            ? <Text dimColor>No progress yet.</Text>
            : recentProgress.map((item) => (
              <Text key={item.itemId}>
                <Text color={statusColor(item.status)}>{item.status}</Text>
                {" "}
                <Text>{item.label}</Text>
                {item.detail ? <Text dimColor> {item.detail}</Text> : null}
              </Text>
            ))}
        </Box>
      </Box>

      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="blue"
        paddingX={1}
        marginTop={1}
        flexGrow={1}
        flexShrink={1}
        minHeight={4}
        overflow="hidden"
      >
        <Text bold>Timeline</Text>
        {recentLogs.length === 0
          ? <Text dimColor>No events yet.</Text>
          : recentLogs.map((entry) => (
            <Text key={entry.id}>
              <Text color={logColor(entry.kind, entry.level)}>{entry.kind}</Text>
              {" "}
              <Text>{entry.text}</Text>
            </Text>
          ))}
      </Box>

      <PromptInput value={input} appHeight={appHeight} terminalColumns={columns} />
    </Box>
  );
}

function PromptInput({ value, appHeight, terminalColumns }: {
  value: string;
  appHeight: number;
  terminalColumns: number;
}) {
  const { setCursorPosition } = useCursor();
  const inputStartX = ROOT_PADDING_X
    + INPUT_BORDER_WIDTH
    + INPUT_PADDING_X
    + terminalDisplayWidth(INPUT_PROMPT);
  const inputLineY = appHeight - 2;
  const visibleValue = tailByDisplayWidth(value, Math.max(0, terminalColumns - inputStartX - 2));

  setCursorPosition({
    x: inputStartX + terminalDisplayWidth(visibleValue),
    y: inputLineY,
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={INPUT_PADDING_X}
      marginTop={1}
      flexShrink={0}
    >
      <Text>
        <Text color="cyan">{INPUT_PROMPT}</Text>
        <Text>{visibleValue}</Text>
      </Text>
    </Box>
  );
}

function statusColor(status: string | undefined): "green" | "yellow" | "red" | "gray" {
  if (status === "complete" || status === "completed" || status === "passed") return "green";
  if (status === "failed" || status === "blocked" || status === "stopped") return "red";
  if (status === "running" || status === "inProgress" || status === "waiting_for_human_input") return "yellow";
  return "gray";
}

function logColor(kind: string, level?: string): "cyan" | "green" | "yellow" | "red" | "blue" | "gray" {
  if (level === "error") return "red";
  if (level === "warn") return "yellow";
  if (kind === "agent") return "green";
  if (kind === "task") return "blue";
  if (kind === "input") return "yellow";
  if (kind === "progress") return "cyan";
  return "gray";
}

function terminalDisplayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    if (isZeroWidthCodePoint(char.codePointAt(0) ?? 0)) continue;
    width += isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

function tailByDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const chars = Array.from(value);
  let width = 0;
  const output: string[] = [];
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index] ?? "";
    const charWidth = terminalDisplayWidth(char);
    if (width + charWidth > maxWidth) break;
    width += charWidth;
    output.push(char);
  }
  return output.reverse().join("");
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return codePoint === 0
    || codePoint < 32
    || (codePoint >= 0x7f && codePoint < 0xa0)
    || (codePoint >= 0x300 && codePoint <= 0x36f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f);
}

function isWideCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

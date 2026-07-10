import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Text,
  useCursor,
  useInput,
  useStdout,
  useWindowSize,
} from "ink";
import type { RuntimeProgressEvent } from "../port.js";
import type {
  TuiLogEntry,
  TuiRunStatus,
  TuiState,
  TuiStore,
} from "./tui-store.js";
import {
  mouseWheelDelta,
  parseSgrMouseEvent,
  resolveActivityScrollTop,
  scrollActivity,
} from "./activity-viewport.js";
import {
  buildTerminalMarkdownLines,
  type TerminalMarkdownSpan,
} from "./terminal-markdown.js";
import {
  tailByDisplayWidth,
  terminalDisplayWidth,
  truncateByDisplayWidth,
  wrapByDisplayWidth,
} from "./terminal-text.js";

export interface ScoutTuiAppProps {
  store: TuiStore;
  onExit: () => void;
}

const ROOT_PADDING_X = 2;
const INPUT_BORDER_WIDTH = 1;
const INPUT_PADDING_X = 1;
const INPUT_PROMPT = "> ";
const MIN_APP_HEIGHT = 14;
const COMPACT_FIXED_ROWS = 19;
const FULL_FIXED_ROWS = 25;
// SGR mouse coordinates are 1-based; these point to the first rendered Activity body row.
const COMPACT_ACTIVITY_BODY_TOP = 15;
const FULL_ACTIVITY_BODY_TOP = 21;
const MOUSE_TRACKING_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_TRACKING_OFF = "\u001b[?1006l\u001b[?1000l";
const FULL_LOGO = [
  "  ____   ____ ___  _   _ _____",
  " / ___| / ___/ _ \\| | | |_   _|",
  " \\___ \\| |  | | | | | | | | |",
  "  ___) | |__| |_| | |_| | | |",
  " |____/ \\____\\___/ \\___/  |_|",
];

export function ScoutTuiApp({ store, onExit }: ScoutTuiAppProps) {
  const [state, setState] = useState<TuiState>(() => store.snapshot());
  const [input, setInput] = useState("");
  const [activityScrollTop, setActivityScrollTop] = useState<number | null>(null);
  const { stdout } = useStdout();
  const { columns, rows } = useWindowSize();
  const appHeight = Math.max(MIN_APP_HEIGHT, rows - 1);
  const compact = columns < 68 || rows < 30;
  const rootPaddingX = columns < 48 ? 1 : ROOT_PADDING_X;
  const activityViewportRows = Math.max(
    1,
    appHeight - (compact ? COMPACT_FIXED_ROWS : FULL_FIXED_ROWS),
  );
  const activityBodyTop = compact ? COMPACT_ACTIVITY_BODY_TOP : FULL_ACTIVITY_BODY_TOP;
  const activityWidth = Math.max(8, columns - (rootPaddingX * 2));

  useEffect(() => store.subscribe(setState), [store]);
  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write(MOUSE_TRACKING_ON);
    return () => {
      stdout.write(MOUSE_TRACKING_OFF);
    };
  }, [stdout]);

  const activeTasks = useMemo(
    () => state.tasks.filter((task) => isActiveStatus(task.status)).length,
    [state.tasks],
  );
  const activityRows = useMemo(
    () => buildActivityRows(state, activityWidth),
    [activityWidth, state],
  );
  const resolvedScrollTop = resolveActivityScrollTop(
    activityRows.length,
    activityViewportRows,
    activityScrollTop,
  );
  const visibleActivityRows = activityRows.slice(
    resolvedScrollTop,
    resolvedScrollTop + activityViewportRows,
  );

  useEffect(() => {
    if (activityScrollTop === null || activityScrollTop === resolvedScrollTop) return;
    setActivityScrollTop(resolvedScrollTop);
  }, [activityScrollTop, resolvedScrollTop]);

  const scrollBy = (delta: number) => {
    setActivityScrollTop((current) =>
      scrollActivity(activityRows.length, activityViewportRows, current, delta)
    );
  };

  useInput((value, key) => {
    const mouse = parseSgrMouseEvent(value);
    if (mouse) {
      const delta = mouseWheelDelta(mouse);
      const activityStartY = activityBodyTop;
      const activityEndY = activityBodyTop + activityViewportRows - 1;
      if (delta !== undefined && mouse.y >= activityStartY && mouse.y <= activityEndY) {
        scrollBy(delta);
      }
      return;
    }
    if (key.ctrl && value === "c") {
      onExit();
      return;
    }
    if (key.upArrow) {
      scrollBy(-1);
      return;
    }
    if (key.downArrow) {
      scrollBy(1);
      return;
    }
    if (key.pageUp) {
      scrollBy(-activityViewportRows);
      return;
    }
    if (key.pageDown) {
      scrollBy(activityViewportRows);
      return;
    }
    if (key.home) {
      setActivityScrollTop(activityRows.length > activityViewportRows ? 0 : null);
      return;
    }
    if (key.end) {
      setActivityScrollTop(null);
      return;
    }
    if (key.return) {
      const submitted = input.trim();
      if (submitted === "/exit") {
        setInput("");
        onExit();
        return;
      }
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

  return (
    <Box
      flexDirection="column"
      height={appHeight}
      paddingX={rootPaddingX}
      overflow="hidden"
    >
      <TopLine state={state} terminalColumns={columns} rootPaddingX={rootPaddingX} />

      <Box marginTop={compact ? 0 : 1} flexDirection="column" flexShrink={0}>
        <Text bold>scout</Text>
        {compact
          ? <Text color="cyan" bold>SCOUT</Text>
          : FULL_LOGO.map((line) => <Text key={line} color="cyan">{line}</Text>)}
      </Box>

      <RuntimeCard
        state={state}
        activeTasks={activeTasks}
        compact={compact}
        terminalColumns={columns}
        rootPaddingX={rootPaddingX}
      />

      <RuntimeStatusLine state={state} activeTasks={activeTasks} />

      <ActivityFeed
        rows={visibleActivityRows}
        totalRows={activityRows.length}
        scrollTop={resolvedScrollTop}
        viewportRows={activityViewportRows}
        followingTail={activityScrollTop === null}
      />

      <PromptInput
        value={input}
        appHeight={appHeight}
        terminalColumns={columns}
        rootPaddingX={rootPaddingX}
        cwd={state.runtime.cwd}
      />
    </Box>
  );
}

function TopLine({ state, terminalColumns, rootPaddingX }: {
  state: TuiState;
  terminalColumns: number;
  rootPaddingX: number;
}) {
  const run = state.runtime.runId ?? state.runtime.status;
  const text = `v${state.runtime.version}  ${state.runtime.cwd}  run:${run}`;
  return (
    <Text dimColor>
      {truncateByDisplayWidth(text, Math.max(0, terminalColumns - (rootPaddingX * 2)))}
    </Text>
  );
}

function RuntimeCard({
  state,
  activeTasks,
  compact,
  terminalColumns,
  rootPaddingX,
}: {
  state: TuiState;
  activeTasks: number;
  compact: boolean;
  terminalColumns: number;
  rootPaddingX: number;
}) {
  const contentWidth = Math.max(8, terminalColumns - (rootPaddingX * 2) - 4);
  const runId = state.runtime.runId ?? "pending";
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      flexShrink={0}
    >
      <Text wrap="truncate-end">
        <Text color="cyan" bold>{">_ Scout"}</Text>
        <Text dimColor>{`  v${state.runtime.version}`}</Text>
        <Text>  validation runtime</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>status: </Text>
        <Text color={runtimeStatusColor(state.runtime.status)}>{state.runtime.status}</Text>
        <Text dimColor>{`  run: ${runId}`}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>model: </Text>
        <Text>{state.runtime.model}</Text>
        <Text dimColor>{`  reasoning: ${state.runtime.reasoningEffort}`}</Text>
      </Text>
      {!compact && (
        <Text wrap="truncate-end">
          <Text dimColor>activity: </Text>
          <Text>{`${state.progress.length} items`}</Text>
          <Text dimColor>{`  tasks: ${activeTasks} active / ${state.tasks.length} total`}</Text>
        </Text>
      )}
      <Text wrap="truncate-end">
        <Text dimColor>directory: </Text>
        <Text>{truncateByDisplayWidth(state.runtime.cwd, Math.max(0, contentWidth - 11))}</Text>
      </Text>
    </Box>
  );
}

function RuntimeStatusLine({ state, activeTasks }: {
  state: TuiState;
  activeTasks: number;
}) {
  const presentation = runtimeStatusPresentation(state.runtime.status, activeTasks);
  return (
    <Box marginTop={1} flexShrink={0}>
      <Text color={presentation.color} bold>{presentation.marker} {presentation.label}</Text>
      <Text dimColor> - {presentation.detail}</Text>
    </Box>
  );
}

function ActivityFeed({ rows, totalRows, scrollTop, viewportRows, followingTail }: {
  rows: ActivityDisplayRow[];
  totalRows: number;
  scrollTop: number;
  viewportRows: number;
  followingTail: boolean;
}) {
  const visibleEnd = Math.min(totalRows, scrollTop + viewportRows);
  const newerRows = Math.max(0, totalRows - visibleEnd);
  const position = totalRows === 0
    ? ""
    : newerRows > 0
      ? `${scrollTop + 1}-${visibleEnd}/${totalRows}  ${newerRows} newer`
      : `${Math.min(totalRows, scrollTop + 1)}-${visibleEnd}/${totalRows}${followingTail ? "" : "  end"}`;
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={3} marginTop={1} overflow="hidden">
      <Box justifyContent="space-between" flexShrink={0}>
        <Text bold>Activity</Text>
        <Text dimColor>{position}</Text>
      </Box>
      {rows.length === 0
        ? <Text dimColor>Waiting for Coordinator and Worker activity.</Text>
        : rows.map((row) => <ActivityLine key={row.id} row={row} />)}
    </Box>
  );
}

function ActivityLine({ row }: { row: ActivityDisplayRow }) {
  if (row.spacer) return <Text> </Text>;
  const { entry } = row;
  if (entry.kind === "progress") {
    const prefixWidth = progressPrefixWidth(entry);
    return (
      <Text wrap="truncate-end">
        {row.first
          ? <>
              <Text color={agentColor(entry.agentId)} bold>{agentLabel(entry.agentId)}</Text>
              <Text color={entry.type === "reasoning" ? "gray" : statusColor(entry.status)}>
                {` ${statusMarker(entry.status)} `}
              </Text>
            </>
          : <Text>{" ".repeat(prefixWidth)}</Text>}
        <ActivityText
          spans={row.spans}
          text={row.text}
          dimColor={entry.type === "reasoning"}
        />
      </Text>
    );
  }
  const prefixWidth = logPrefixWidth(entry);
  return (
    <Text wrap="truncate-end">
      {row.first
        ? <>
            <Text color={logColor(entry.log)} bold>{logLabel(entry.log)}</Text>
            <Text> </Text>
          </>
        : <Text>{" ".repeat(prefixWidth)}</Text>}
      <ActivityText spans={row.spans} text={row.text} />
    </Text>
  );
}

function ActivityText({ spans, text, dimColor = false }: {
  spans?: TerminalMarkdownSpan[];
  text: string;
  dimColor?: boolean;
}) {
  if (!spans) return <Text dimColor={dimColor}>{text}</Text>;
  return (
    <Text>
      {spans.map((span, index) => (
        <Text
          key={`${index}:${span.text}`}
          bold={span.style?.bold}
          italic={span.style?.italic}
          underline={span.style?.underline}
          strikethrough={span.style?.strikethrough}
          inverse={span.style?.inverse}
          color={span.style?.color}
          dimColor={dimColor || span.style?.dimColor}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

function PromptInput({ value, appHeight, terminalColumns, rootPaddingX, cwd }: {
  value: string;
  appHeight: number;
  terminalColumns: number;
  rootPaddingX: number;
  cwd: string;
}) {
  const { setCursorPosition } = useCursor();
  const inputStartX = rootPaddingX
    + INPUT_BORDER_WIDTH
    + INPUT_PADDING_X
    + terminalDisplayWidth(INPUT_PROMPT);
  const inputLineY = Math.max(0, appHeight - 3);
  const visibleValue = tailByDisplayWidth(
    value,
    Math.max(0, terminalColumns - inputStartX - 2),
  );
  const footer = `enter to send - /exit to quit - Ctrl+C to quit - cwd ${cwd}`;

  setCursorPosition({
    x: inputStartX + terminalDisplayWidth(visibleValue),
    y: inputLineY,
  });

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={INPUT_PADDING_X}
        marginTop={1}
        flexShrink={0}
      >
        <Text wrap="truncate-end">
          <Text color="cyan">{INPUT_PROMPT}</Text>
          {visibleValue
            ? <Text>{visibleValue}</Text>
            : <Text dimColor>Ask Scout...</Text>}
        </Text>
      </Box>
      <Text dimColor>
        {truncateByDisplayWidth(footer, Math.max(0, terminalColumns - (rootPaddingX * 2)))}
      </Text>
    </Box>
  );
}

type ActivityEntry = ProgressActivityEntry | LogActivityEntry;

interface ProgressActivityEntry {
  id: string;
  kind: "progress";
  createdAt: string;
  agentId?: string;
  status: string;
  type: string;
  label: string;
  detail?: string;
}

interface LogActivityEntry {
  id: string;
  kind: "log";
  createdAt: string;
  log: TuiLogEntry;
}

export interface ActivityDisplayRow {
  id: string;
  entry: ActivityEntry;
  first: boolean;
  text: string;
  spans?: TerminalMarkdownSpan[];
  spacer?: boolean;
}

function buildActivity(state: TuiState): ActivityEntry[] {
  const progress = state.progress.map(toProgressActivity);
  const logs = state.logs.map((log): LogActivityEntry => ({
    id: log.id,
    kind: "log",
    createdAt: log.createdAt,
    log,
  }));
  return [...progress, ...logs].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );
}

function toProgressActivity(event: RuntimeProgressEvent): ProgressActivityEntry {
  return {
    id: `progress:${event.agentId ?? "runtime"}:${event.itemId}`,
    kind: "progress",
    createdAt: event.updatedAt,
    agentId: event.agentId,
    status: event.status,
    type: event.type,
    label: event.label,
    detail: event.detail,
  };
}

export function buildActivityRows(state: TuiState, width: number): ActivityDisplayRow[] {
  const activity = buildActivity(state);
  return activity.flatMap((entry, entryIndex) => {
    const prefixWidth = entry.kind === "progress"
      ? progressPrefixWidth(entry)
      : logPrefixWidth(entry);
    const bodyWidth = Math.max(1, width - prefixWidth);
    const content = activityContentRows(entry, bodyWidth);
    const rows: ActivityDisplayRow[] = content.map((line, index) => ({
      id: `${entry.id}:row:${index}`,
      entry,
      first: index === 0,
      text: line.text,
      spans: line.spans,
    }));
    if (entryIndex < activity.length - 1) {
      rows.push({
        id: `${entry.id}:spacer`,
        entry,
        first: false,
        text: "",
        spacer: true,
      });
    }
    return rows;
  });
}

function activityContentRows(
  entry: ActivityEntry,
  bodyWidth: number,
): Array<{ text: string; spans?: TerminalMarkdownSpan[] }> {
  if (shouldRenderMarkdown(entry)) {
    const markdown = entry.kind === "progress"
      ? `${entry.label}${entry.detail ? `  ${entry.detail}` : ""}`
      : entry.log.text;
    return buildTerminalMarkdownLines(markdown, bodyWidth).map((line) => ({
      text: line.spans.map((span) => span.text).join(""),
      spans: line.spans,
    }));
  }
  if (entry.kind === "log") {
    return wrapByDisplayWidth(entry.log.text, bodyWidth).map((text) => ({ text }));
  }
  const text = `${entry.label}${entry.detail ? `  ${entry.detail}` : ""}`;
  return [{ text: truncateByDisplayWidth(text.replace(/\s+/g, " ").trim(), bodyWidth) }];
}

function shouldRenderMarkdown(entry: ActivityEntry): boolean {
  return entry.kind === "progress"
    ? entry.type === "reasoning"
    : entry.log.kind === "agent";
}

function progressPrefixWidth(entry: ProgressActivityEntry): number {
  return terminalDisplayWidth(agentLabel(entry.agentId)) + 3;
}

function logPrefixWidth(entry: LogActivityEntry): number {
  return terminalDisplayWidth(logLabel(entry.log)) + 1;
}

function runtimeStatusPresentation(status: TuiRunStatus, activeTasks: number): {
  marker: string;
  label: string;
  detail: string;
  color: "green" | "yellow" | "red" | "gray";
} {
  if (status === "ready") {
    return {
      marker: "*",
      label: "Scout runtime ready",
      detail: activeTasks > 0 ? `${activeTasks} active task${activeTasks === 1 ? "" : "s"}` : "Waiting for input",
      color: "green",
    };
  }
  if (status === "failed") {
    return { marker: "!", label: "Scout runtime failed", detail: "Review activity for details", color: "red" };
  }
  if (status === "stopping") {
    return { marker: "-", label: "Scout runtime stopping", detail: "Cleaning up", color: "gray" };
  }
  return { marker: "*", label: "Preparing Scout runtime", detail: "Starting agents", color: "yellow" };
}

function runtimeStatusColor(status: TuiRunStatus): "green" | "yellow" | "red" | "gray" {
  if (status === "ready") return "green";
  if (status === "failed") return "red";
  if (status === "preparing") return "yellow";
  return "gray";
}

function agentLabel(agentId: string | undefined): string {
  if (!agentId) return "RUNTIME";
  if (agentId === "coordinator") return "COORD";
  return agentId.toUpperCase();
}

function agentColor(agentId: string | undefined): "cyan" | "green" | "gray" {
  if (agentId === "coordinator") return "cyan";
  if (agentId) return "green";
  return "gray";
}

function statusColor(status: string | undefined): "green" | "yellow" | "red" | "gray" {
  if (status === "complete" || status === "completed" || status === "passed") return "green";
  if (status === "failed" || status === "blocked" || status === "stopped") return "red";
  if (status === "running" || status === "inProgress" || status === "waiting_for_human_input") return "yellow";
  return "gray";
}

function statusMarker(status: string | undefined): string {
  if (status === "complete" || status === "completed" || status === "passed") return "+";
  if (status === "failed" || status === "blocked" || status === "stopped") return "!";
  if (status === "running" || status === "inProgress" || status === "waiting_for_human_input") return ">";
  return "o";
}

function logColor(entry: TuiLogEntry): "cyan" | "green" | "yellow" | "red" | "blue" | "gray" {
  if (entry.level === "error") return "red";
  if (entry.level === "warn") return "yellow";
  if (entry.agentId === "coordinator") return "cyan";
  if (entry.agentId) return "green";
  if (entry.kind === "input") return "yellow";
  if (entry.kind === "task") return "blue";
  return "gray";
}

function logLabel(entry: TuiLogEntry): string {
  if (entry.agentId) return agentLabel(entry.agentId);
  if (entry.kind === "input") return "YOU";
  if (entry.kind === "task") return "TASK";
  return "RUNTIME";
}

function isActiveStatus(status: string | undefined): boolean {
  return status === "queued"
    || status === "running"
    || status === "waiting_for_human_input";
}

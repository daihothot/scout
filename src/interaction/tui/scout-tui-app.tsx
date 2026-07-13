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
  TuiTaskPlanStep,
  TuiTaskSummary,
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
import {
  buildTaskStepDisplay,
  isTerminalTaskStatus,
  resolveTaskStepWindow,
  resolveTuiWorkspaceLayout,
  selectCurrentTask,
} from "./workspace-layout.js";

export interface ScoutTuiAppProps {
  store: TuiStore;
  onExit: () => void;
}

type ActivityViewport = "coordinator" | "worker";

const ROOT_PADDING_X = 2;
const INPUT_BORDER_WIDTH = 1;
const INPUT_PADDING_X = 1;
const INPUT_PROMPT = "> ";
const MIN_APP_HEIGHT = 14;
const MIN_INLINE_ACTIVITY_BODY_WIDTH = 16;
const COMPACT_PRE_WORKSPACE_ROWS = 12;
const FULL_PRE_WORKSPACE_ROWS = 18;
const PROMPT_ROWS = 5;
const MOUSE_TRACKING_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_TRACKING_OFF = "\u001b[?1006l\u001b[?1000l";
const FULL_LOGO = [
  "  ____   ____ ___  _   _ _____",
  " / ___| / ___/ _ \\| | | |_   _|",
  " \\___ \\| |  | | | | | | | | |",
  "  ___) | |__| |_| | |_| | | |",
  " |____/ \\____\\___/ \\___/  |_|",
];

export interface TuiWidths {
  terminalWidth: number;
  rootPaddingX: number;
  contentWidth: number;
  inputValueWidth: number;
}

export function resolveTuiWidths(columns: number): TuiWidths {
  const terminalWidth = Math.max(1, Number.isFinite(columns) ? Math.floor(columns) : 1);
  const rootPaddingX = terminalWidth < 24 ? 0 : terminalWidth < 48 ? 1 : ROOT_PADDING_X;
  const contentWidth = Math.max(1, terminalWidth - (rootPaddingX * 2));
  const inputValueWidth = Math.max(
    0,
    contentWidth
      - (INPUT_BORDER_WIDTH * 2)
      - (INPUT_PADDING_X * 2)
      - terminalDisplayWidth(INPUT_PROMPT),
  );
  return {
    terminalWidth,
    rootPaddingX,
    contentWidth,
    inputValueWidth,
  };
}

export function ScoutTuiApp({ store, onExit }: ScoutTuiAppProps) {
  const [state, setState] = useState<TuiState>(() => store.snapshot());
  const [input, setInput] = useState("");
  const [coordinatorScrollTop, setCoordinatorScrollTop] = useState<number | null>(null);
  const [workerScrollTop, setWorkerScrollTop] = useState<number | null>(null);
  const [focusedViewport, setFocusedViewport] = useState<ActivityViewport>("coordinator");
  const { stdout } = useStdout();
  const { columns, rows } = useWindowSize();
  const widths = resolveTuiWidths(columns);
  const appHeight = Math.max(MIN_APP_HEIGHT, rows - 1);
  const currentTask = useMemo(() => selectCurrentTask(state.tasks), [state.tasks]);
  const workerOpen = Boolean(currentTask && !isTerminalTaskStatus(currentTask.status));
  const compact = widths.terminalWidth < 68
    || rows < 30
    || (currentTask !== undefined && rows < 40);
  const preWorkspaceRows = compact
    ? COMPACT_PRE_WORKSPACE_ROWS
    : FULL_PRE_WORKSPACE_ROWS;
  const availableWorkspaceRows = Math.max(
    1,
    appHeight - preWorkspaceRows - PROMPT_ROWS,
  );
  const workspaceLayout = resolveTuiWorkspaceLayout({
    availableRows: availableWorkspaceRows,
    hasTask: currentTask !== undefined,
    workerOpen,
    planStepCount: currentTask?.planSteps.length ?? 0,
  });
  const taskStepWindow = resolveTaskStepWindow(
    currentTask?.planSteps ?? [],
    workspaceLayout.taskStepRows,
  );

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
  const coordinatorActivityRows = useMemo(
    () => buildCoordinatorActivityRows(state, widths.contentWidth),
    [state, widths.contentWidth],
  );
  const workerActivityRows = useMemo(
    () => currentTask
      ? buildWorkerActivityRows(state, currentTask.taskId, widths.contentWidth)
      : [],
    [currentTask, state, widths.contentWidth],
  );
  const resolvedCoordinatorScrollTop = resolveActivityScrollTop(
    coordinatorActivityRows.length,
    workspaceLayout.coordinatorViewportRows,
    coordinatorScrollTop,
  );
  const resolvedWorkerScrollTop = resolveActivityScrollTop(
    workerActivityRows.length,
    Math.max(1, workspaceLayout.workerViewportRows),
    workerScrollTop,
  );
  const visibleCoordinatorRows = coordinatorActivityRows.slice(
    resolvedCoordinatorScrollTop,
    resolvedCoordinatorScrollTop + workspaceLayout.coordinatorViewportRows,
  );
  const visibleWorkerRows = workerActivityRows.slice(
    resolvedWorkerScrollTop,
    resolvedWorkerScrollTop + workspaceLayout.workerViewportRows,
  );

  useEffect(() => {
    if (coordinatorScrollTop === null || coordinatorScrollTop === resolvedCoordinatorScrollTop) return;
    setCoordinatorScrollTop(resolvedCoordinatorScrollTop);
  }, [coordinatorScrollTop, resolvedCoordinatorScrollTop]);
  useEffect(() => {
    if (workerScrollTop === null || workerScrollTop === resolvedWorkerScrollTop) return;
    setWorkerScrollTop(resolvedWorkerScrollTop);
  }, [resolvedWorkerScrollTop, workerScrollTop]);
  useEffect(() => {
    setWorkerScrollTop(null);
  }, [currentTask?.taskId]);
  useEffect(() => {
    if (workerOpen) return;
    setFocusedViewport("coordinator");
    setWorkerScrollTop(null);
  }, [workerOpen]);

  const scrollCoordinatorBy = (delta: number) => {
    setCoordinatorScrollTop((current) =>
      scrollActivity(
        coordinatorActivityRows.length,
        workspaceLayout.coordinatorViewportRows,
        current,
        delta,
      )
    );
  };
  const scrollWorkerBy = (delta: number) => {
    setWorkerScrollTop((current) =>
      scrollActivity(
        workerActivityRows.length,
        Math.max(1, workspaceLayout.workerViewportRows),
        current,
        delta,
      )
    );
  };
  const scrollFocusedBy = (delta: number) => {
    if (focusedViewport === "worker" && workerOpen) {
      scrollWorkerBy(delta);
      return;
    }
    scrollCoordinatorBy(delta);
  };
  const setFocusedScrollTop = (value: number | null) => {
    if (focusedViewport === "worker" && workerOpen) {
      setWorkerScrollTop(value);
      return;
    }
    setCoordinatorScrollTop(value);
  };
  const coordinatorStartY = preWorkspaceRows + workspaceLayout.coordinatorHeaderOffset + 1;
  const coordinatorEndY = preWorkspaceRows
    + workspaceLayout.coordinatorBodyOffset
    + workspaceLayout.coordinatorViewportRows;
  const workerStartY = workspaceLayout.workerHeaderOffset === undefined
    ? undefined
    : preWorkspaceRows + workspaceLayout.workerHeaderOffset + 1;
  const workerEndY = workspaceLayout.workerBodyOffset === undefined
    ? undefined
    : preWorkspaceRows + workspaceLayout.workerBodyOffset + workspaceLayout.workerViewportRows;

  useInput((value, key) => {
    const mouse = parseSgrMouseEvent(value);
    if (mouse) {
      const delta = mouseWheelDelta(mouse);
      if (
        workerOpen
        && workerStartY !== undefined
        && workerEndY !== undefined
        && mouse.y >= workerStartY
        && mouse.y <= workerEndY
      ) {
        setFocusedViewport("worker");
        if (delta !== undefined) scrollWorkerBy(delta);
        return;
      }
      if (mouse.y >= coordinatorStartY && mouse.y <= coordinatorEndY) {
        setFocusedViewport("coordinator");
        if (delta !== undefined) scrollCoordinatorBy(delta);
      }
      return;
    }
    if (key.ctrl && value === "c") {
      onExit();
      return;
    }
    if (key.tab && workerOpen) {
      setFocusedViewport((current) => current === "coordinator" ? "worker" : "coordinator");
      return;
    }
    if (key.upArrow) {
      scrollFocusedBy(-1);
      return;
    }
    if (key.downArrow) {
      scrollFocusedBy(1);
      return;
    }
    if (key.pageUp) {
      const pageRows = focusedViewport === "worker" && workerOpen
        ? workspaceLayout.workerViewportRows
        : workspaceLayout.coordinatorViewportRows;
      scrollFocusedBy(-pageRows);
      return;
    }
    if (key.pageDown) {
      const pageRows = focusedViewport === "worker" && workerOpen
        ? workspaceLayout.workerViewportRows
        : workspaceLayout.coordinatorViewportRows;
      scrollFocusedBy(pageRows);
      return;
    }
    if (key.home) {
      const totalRows = focusedViewport === "worker" && workerOpen
        ? workerActivityRows.length
        : coordinatorActivityRows.length;
      const viewportRows = focusedViewport === "worker" && workerOpen
        ? workspaceLayout.workerViewportRows
        : workspaceLayout.coordinatorViewportRows;
      setFocusedScrollTop(totalRows > viewportRows ? 0 : null);
      return;
    }
    if (key.end) {
      setFocusedScrollTop(null);
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
      width={widths.terminalWidth}
      height={appHeight}
      paddingX={widths.rootPaddingX}
      overflow="hidden"
    >
      <TopLine state={state} width={widths.contentWidth} />

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
        width={widths.contentWidth}
      />

      <RuntimeStatusLine
        state={state}
        activeTasks={activeTasks}
        width={widths.contentWidth}
      />

      <Box
        flexDirection="column"
        width={widths.contentWidth}
        height={workspaceLayout.totalRows}
        overflow="hidden"
        flexShrink={0}
      >
        <ActivityFeed
          title="Activity"
          width={widths.contentWidth}
          marginTop={workspaceLayout.topMarginRows}
          rows={visibleCoordinatorRows}
          totalRows={coordinatorActivityRows.length}
          scrollTop={resolvedCoordinatorScrollTop}
          viewportRows={workspaceLayout.coordinatorViewportRows}
          followingTail={coordinatorScrollTop === null}
          focused={focusedViewport === "coordinator"}
          emptyText="Waiting for Coordinator activity."
        />

        {currentTask && (
          <TaskPanel
            task={currentTask}
            width={widths.contentWidth}
            marginTop={workspaceLayout.sectionGapRows}
            stepWindow={taskStepWindow}
          />
        )}

        {workerOpen && (
          <ActivityFeed
            title="Worker Activity"
            width={widths.contentWidth}
            marginTop={workspaceLayout.sectionGapRows}
            rows={visibleWorkerRows}
            totalRows={workerActivityRows.length}
            scrollTop={resolvedWorkerScrollTop}
            viewportRows={workspaceLayout.workerViewportRows}
            followingTail={workerScrollTop === null}
            focused={focusedViewport === "worker"}
            emptyText="Waiting for Worker activity."
          />
        )}
      </Box>

      <PromptInput
        value={input}
        appHeight={appHeight}
        widths={widths}
        cwd={state.runtime.cwd}
      />
    </Box>
  );
}

function TopLine({ state, width }: {
  state: TuiState;
  width: number;
}) {
  const run = state.runtime.runId ?? state.runtime.status;
  const text = `v${state.runtime.version}  ${state.runtime.cwd}  run:${run}`;
  return (
    <Text dimColor>
      {truncateByDisplayWidth(text, width)}
    </Text>
  );
}

function RuntimeCard({
  state,
  activeTasks,
  compact,
  width,
}: {
  state: TuiState;
  activeTasks: number;
  compact: boolean;
  width: number;
}) {
  const contentWidth = Math.max(0, width - 4);
  const runId = state.runtime.runId ?? "pending";
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      width={width}
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

function RuntimeStatusLine({ state, activeTasks, width }: {
  state: TuiState;
  activeTasks: number;
  width: number;
}) {
  const presentation = runtimeStatusPresentation(state.runtime.status, activeTasks);
  return (
    <Box marginTop={1} width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={presentation.color} bold>{presentation.marker} {presentation.label}</Text>
        <Text dimColor> - {presentation.detail}</Text>
      </Text>
    </Box>
  );
}

function ActivityFeed({
  title,
  width,
  marginTop,
  rows,
  totalRows,
  scrollTop,
  viewportRows,
  followingTail,
  focused,
  emptyText,
}: {
  title: string;
  width: number;
  marginTop: number;
  rows: ActivityDisplayRow[];
  totalRows: number;
  scrollTop: number;
  viewportRows: number;
  followingTail: boolean;
  focused: boolean;
  emptyText: string;
}) {
  const visibleEnd = Math.min(totalRows, scrollTop + viewportRows);
  const newerRows = Math.max(0, totalRows - visibleEnd);
  const position = totalRows === 0
    ? ""
    : newerRows > 0
      ? `${scrollTop + 1}-${visibleEnd}/${totalRows}  ${newerRows} newer`
      : `${Math.min(totalRows, scrollTop + 1)}-${visibleEnd}/${totalRows}${followingTail ? "" : "  end"}`;
  const visiblePosition = width > terminalDisplayWidth(title) + 1
    ? truncateByDisplayWidth(position, width - terminalDisplayWidth(title) - 1)
    : "";
  return (
    <Box
      flexDirection="column"
      width={width}
      height={viewportRows + 1}
      marginTop={marginTop}
      flexShrink={0}
      overflow="hidden"
    >
      <Box width={width} justifyContent="space-between" flexShrink={0}>
        <Text color={focused ? "cyan" : undefined} bold wrap="truncate-end">{title}</Text>
        <Text dimColor wrap="truncate-end">{visiblePosition}</Text>
      </Box>
      {totalRows === 0
        ? <Text dimColor>{emptyText}</Text>
        : rows.map((row) => <ActivityLine key={row.id} row={row} />)}
    </Box>
  );
}

function TaskPanel({ task, width, marginTop, stepWindow }: {
  task: TuiTaskSummary;
  width: number;
  marginTop: number;
  stepWindow: {
    start: number;
    steps: TuiTaskPlanStep[];
  };
}) {
  const status = task.status ?? "unknown";
  const range = stepWindow.steps.length < task.planSteps.length
    ? ` ${stepWindow.start + 1}-${stepWindow.start + stepWindow.steps.length}/${task.planSteps.length}`
    : "";
  const statusWidth = Math.min(width, terminalDisplayWidth(status));
  const titleWidth = Math.max(0, width - statusWidth - (statusWidth > 0 ? 1 : 0));
  const title = truncateByDisplayWidth(`Task ${task.taskId}${range}`, titleWidth);
  return (
    <Box
      flexDirection="column"
      width={width}
      height={stepWindow.steps.length + 1}
      marginTop={marginTop}
      flexShrink={0}
      overflow="hidden"
    >
      <Box width={width} justifyContent="space-between" flexShrink={0}>
        <Text bold wrap="truncate-end">{title}</Text>
        <Text color={statusColor(status)}>{status}</Text>
      </Box>
      {stepWindow.steps.map((step, index) => (
        <TaskStepLine
          key={`${stepWindow.start + index}:${step.step}`}
          step={step}
          width={width}
        />
      ))}
    </Box>
  );
}

function TaskStepLine({ step, width }: {
  step: TuiTaskPlanStep;
  width: number;
}) {
  const display = buildTaskStepDisplay(step, width);
  return (
    <Text wrap="truncate-end">
      <Text color={statusColor(step.status)}>{display.marker} </Text>
      <Text>{display.label}{display.labelPadding}</Text>
      <Text color={statusColor(step.status)}>{display.status}</Text>
    </Text>
  );
}

function ActivityLine({ row }: { row: ActivityDisplayRow }) {
  if (row.spacer) return <Text> </Text>;
  const { entry } = row;
  if (!row.first && row.leadingWidth === 0 && row.text.length === 0) {
    return <Text> </Text>;
  }
  return (
    <Text wrap="truncate-end">
      {row.first
        ? <ActivityPrefix entry={entry} />
        : <Text>{" ".repeat(row.leadingWidth)}</Text>}
      {!row.prefixOnly && (
        <ActivityText
          spans={row.spans}
          text={row.text}
          dimColor={entry.kind === "progress" && entry.type === "reasoning"}
        />
      )}
    </Text>
  );
}

function ActivityPrefix({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === "progress") {
    return (
      <>
        <Text color={agentColor(entry.agentId)} bold>{agentLabel(entry.agentId)}</Text>
        <Text color={entry.type === "reasoning" ? "gray" : statusColor(entry.status)}>
          {` ${statusMarker(entry.status)} `}
        </Text>
      </>
    );
  }
  return (
    <>
      <Text color={logColor(entry.log)} bold>{logLabel(entry.log)}</Text>
      <Text> </Text>
    </>
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

function PromptInput({ value, appHeight, widths, cwd }: {
  value: string;
  appHeight: number;
  widths: TuiWidths;
  cwd: string;
}) {
  const { setCursorPosition } = useCursor();
  const inputStartX = widths.rootPaddingX
    + INPUT_BORDER_WIDTH
    + INPUT_PADDING_X
    + terminalDisplayWidth(INPUT_PROMPT);
  const inputLineY = Math.max(0, appHeight - 3);
  const visibleValue = tailByDisplayWidth(value, widths.inputValueWidth);
  const footer = `enter to send - /exit to quit - Ctrl+C to quit - cwd ${cwd}`;

  setCursorPosition({
    x: Math.min(
      widths.terminalWidth - 1,
      inputStartX + terminalDisplayWidth(visibleValue),
    ),
    y: inputLineY,
  });

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={INPUT_PADDING_X}
        marginTop={1}
        width={widths.contentWidth}
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
        {truncateByDisplayWidth(footer, widths.contentWidth)}
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
  leadingWidth: number;
  text: string;
  spans?: TerminalMarkdownSpan[];
  prefixOnly?: boolean;
  spacer?: boolean;
}

function buildCoordinatorActivity(state: TuiState): ActivityEntry[] {
  const progress = state.progress
    .filter((event) => !event.agentId || event.agentId === "coordinator")
    .map(toProgressActivity);
  const logs = state.logs
    .filter((log) => !log.agentId || log.agentId === "coordinator")
    .map((log): LogActivityEntry => ({
      id: log.id,
      kind: "log",
      createdAt: log.createdAt,
      log,
    }));
  return sortActivity([...progress, ...logs]);
}

function buildWorkerActivity(state: TuiState, taskId: string): ActivityEntry[] {
  const progress = state.progress
    .filter((event) => event.taskId === taskId && event.agentId !== "coordinator")
    .map(toProgressActivity);
  return sortActivity(progress);
}

function sortActivity(activity: ActivityEntry[]): ActivityEntry[] {
  return activity.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function toProgressActivity(event: RuntimeProgressEvent): ProgressActivityEntry {
  return {
    id: `progress:${event.agentId ?? "runtime"}:${event.taskId ?? "no-task"}:${event.itemId}`,
    kind: "progress",
    createdAt: event.updatedAt,
    agentId: event.agentId,
    status: event.status,
    type: event.type,
    label: event.label,
    detail: event.detail,
  };
}

export function buildCoordinatorActivityRows(
  state: TuiState,
  width: number,
): ActivityDisplayRow[] {
  return buildActivityRows(buildCoordinatorActivity(state), width);
}

export function buildWorkerActivityRows(
  state: TuiState,
  taskId: string,
  width: number,
): ActivityDisplayRow[] {
  return buildActivityRows(buildWorkerActivity(state, taskId), width);
}

function buildActivityRows(
  activity: ActivityEntry[],
  width: number,
): ActivityDisplayRow[] {
  return activity.flatMap((entry, entryIndex) => {
    const prefixWidth = entry.kind === "progress"
      ? progressPrefixWidth(entry)
      : logPrefixWidth(entry);
    const stackPrefix = width < prefixWidth + MIN_INLINE_ACTIVITY_BODY_WIDTH;
    const bodyWidth = Math.max(1, stackPrefix ? width : width - prefixWidth);
    const content = activityContentRows(entry, bodyWidth);
    const rows: ActivityDisplayRow[] = stackPrefix
      ? [
          {
            id: `${entry.id}:prefix`,
            entry,
            first: true,
            leadingWidth: prefixWidth,
            text: "",
            prefixOnly: true,
          },
          ...content.map((line, index) => ({
            id: `${entry.id}:row:${index}`,
            entry,
            first: false,
            leadingWidth: 0,
            text: line.text,
            spans: line.spans,
          })),
        ]
      : content.map((line, index) => ({
          id: `${entry.id}:row:${index}`,
          entry,
          first: index === 0,
          leadingWidth: prefixWidth,
          text: line.text,
          spans: line.spans,
        }));
    if (entryIndex < activity.length - 1) {
      rows.push({
        id: `${entry.id}:spacer`,
        entry,
        first: false,
        leadingWidth: 0,
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
  return wrapByDisplayWidth(
    text.replace(/\s+/g, " ").trim(),
    bodyWidth,
  ).map((wrapped) => ({ text: wrapped }));
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

function logColor(entry: TuiLogEntry): "cyan" | "green" | "yellow" | "red" | "gray" {
  if (entry.level === "error") return "red";
  if (entry.level === "warn") return "yellow";
  if (entry.agentId === "coordinator") return "cyan";
  if (entry.agentId) return "green";
  if (entry.kind === "input") return "yellow";
  return "gray";
}

function logLabel(entry: TuiLogEntry): string {
  if (entry.agentId) return agentLabel(entry.agentId);
  if (entry.kind === "input") return "YOU";
  return "RUNTIME";
}

function isActiveStatus(status: string | undefined): boolean {
  return status === "queued"
    || status === "running"
    || status === "waiting_for_human_input";
}

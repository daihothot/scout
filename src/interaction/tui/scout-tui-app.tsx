import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdout, useWindowSize } from "ink";
import {
  ActivityBar,
  resolveActivityBarRows,
} from "./chrome/activity-bar.js";
import { parseSgrMouseEvent } from "./activity-viewport.js";
import {
  PROMPT_INPUT_ROWS,
  PromptInput,
} from "./chrome/prompt-input.js";
import {
  resolveTopChromeRows,
  TopChrome,
} from "./chrome/top-chrome.js";
import { ChatPanel } from "./panels/chat-panel.js";
import { TasksDrawer } from "./panels/tasks-drawer.js";
import {
  isActiveTaskStatus,
  selectCurrentAgentActivity,
  selectChatItems,
  selectTaskSummaries,
} from "./selectors/index.js";
import { ScoutShell } from "./shell/scout-shell.js";
import type {
  TuiState,
  TuiStore,
} from "./tui-store.js";
import {
  resolveTuiWidths,
  resolveTuiWorkspaceLayout,
} from "./workspace-layout.js";
import {
  buildTuiSelectionSegments,
  extractTuiSelectionText,
  type TuiSelectableLine,
  type TuiSelectionPoint,
  type TuiTextSelection,
  writeTuiClipboard,
} from "./text-selection.js";
import { terminalDisplayWidth } from "./terminal-text.js";

/** Root props connecting the store snapshot to the terminal application. */
export interface ScoutTuiAppProps {
  store: TuiStore;
  onExit: () => void;
}

const MOUSE_TRACKING_ON = "\u001b[?1002h\u001b[?1006h";
const MOUSE_TRACKING_OFF = "\u001b[?1006l\u001b[?1002l\u001b[?1000l";

type SelectableRegion = "chat" | "tasks" | "activity";
type SelectableLinesByRegion = Record<SelectableRegion, TuiSelectableLine[]>;

/** Renders the top-level terminal shell and routes exit requests. */
export function ScoutTuiApp({ store, onExit }: ScoutTuiAppProps) {
  const [state, setState] = useState<TuiState>(() => store.snapshot());
  const [tasksOpen, setTasksOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [mouseCaptureEnabled, setMouseCaptureEnabled] = useState(true);
  const [selectableLinesByRegion, setSelectableLinesByRegion] = useState<SelectableLinesByRegion>({
    chat: [],
    tasks: [],
    activity: [],
  });
  const [selection, setSelection] = useState<TuiTextSelection>();
  const selectionDragRef = useRef<{
    anchor: TuiSelectionPoint;
    focus: TuiSelectionPoint;
  } | undefined>(undefined);
  const clearSelection = useCallback(() => {
    selectionDragRef.current = undefined;
    setSelection(undefined);
  }, []);
  const { stdout } = useStdout();
  const { columns, rows } = useWindowSize();
  const widths = resolveTuiWidths(columns);
  // Ink reserves the trailing output line, so the rendered root uses one fewer
  // row than the terminal viewport. Never invent extra rows when the viewport
  // is short; doing so moves the prompt outside the actual terminal surface.
  const appHeight = Math.max(1, rows - 1);
  const compact = widths.terminalWidth < 68 || rows < 30;
  const inputReady = state.runtime.status === "ready";
  const showLifecycleProgress = Boolean(
    state.lifecycle && state.runtime.status !== "ready",
  );
  const topChromeRows = resolveTopChromeRows(
    compact,
    showLifecycleProgress,
    state.runtime.status !== "ready" ? state.subprocessProgress : undefined,
  );
  const promptRows = inputReady ? PROMPT_INPUT_ROWS : 0;
  const promptTopY = Math.max(0, appHeight - promptRows);
  const availableWorkspaceRows = Math.max(0, appHeight - topChromeRows - promptRows);
  const inputEnabled = inputReady && !tasksOpen;
  const chatItems = useMemo(() => selectChatItems(state), [state]);
  const tasks = useMemo(() => selectTaskSummaries(state), [state]);
  const currentActivity = useMemo(() => selectCurrentAgentActivity(state), [state]);
  const activeTasks = useMemo(
    () => tasks.filter((task) => isActiveTaskStatus(task.status)).length,
    [tasks],
  );
  const workspace = resolveTuiWorkspaceLayout({
    availableRows: availableWorkspaceRows,
    drawerOpen: tasksOpen,
    taskCount: tasks.length,
    taskPlanStepRows: tasks.reduce(
      (maximum, task) => Math.max(
        maximum,
        task.turns.reduce(
          (rows, turn) => rows + 1 + turn.planSteps.length,
          0,
        ),
      ),
      0,
    ),
    desiredActivityRows: resolveActivityBarRows(currentActivity, widths.contentWidth),
  });
  const chatStartY = topChromeRows + workspace.chatOffset + 1;
  const tasksStartY = topChromeRows + workspace.tasksOffset + 1;
  const activityStartY = topChromeRows + workspace.activityOffset + 1;

  const updateSelectableLines = useCallback((
    region: SelectableRegion,
    startY: number,
    lines: string[],
  ) => {
    setSelectableLinesByRegion((current) => {
      const next = lines.map((text, index) => ({ y: startY + index, text }));
      const previous = current[region];
      if (
        previous.length === next.length
        && previous.every((line, index) => line.y === next[index]?.y && line.text === next[index]?.text)
      ) return current;
      return { ...current, [region]: next };
    });
  }, []);
  const updateChatLines = useCallback(
    (lines: string[]) => updateSelectableLines("chat", chatStartY, lines),
    [chatStartY, updateSelectableLines],
  );
  const updateTaskLines = useCallback(
    (lines: string[]) => updateSelectableLines("tasks", tasksStartY, lines),
    [tasksStartY, updateSelectableLines],
  );
  const updateActivityLines = useCallback(
    (lines: string[]) => updateSelectableLines("activity", activityStartY, lines),
    [activityStartY, updateSelectableLines],
  );
  const selectableLines = useMemo(
    () => Object.values(selectableLinesByRegion)
      .flat()
      .sort((left, right) => left.y - right.y),
    [selectableLinesByRegion],
  );
  const selectableLineByY = useMemo(
    () => new Map(selectableLines.map((line) => [line.y, line])),
    [selectableLines],
  );
  const resolveSelectionPoint = useCallback((mouse: {
    x: number;
    y: number;
  }): TuiSelectionPoint | undefined => {
    const line = selectableLineByY.get(mouse.y);
    if (!line) return undefined;
    const lineWidth = terminalDisplayWidth(line.text);
    if (lineWidth === 0) return undefined;
    const localX = mouse.x - 1 - widths.rootPaddingX;
    if (localX < 0 || localX >= widths.contentWidth) return undefined;
    return {
      x: Math.min(lineWidth - 1, localX),
      y: mouse.y,
    };
  }, [selectableLineByY, widths.contentWidth, widths.rootPaddingX]);
  const selectionSegments = useMemo(
    () => buildTuiSelectionSegments(selectableLines, selection),
    [selectableLines, selection],
  );
  const selectionOverlay = selectionSegments.length > 0
    ? (
      <>
        {selectionSegments.map((segment) => (
          <Box
            key={`${segment.y}:${segment.startX}:${segment.text}`}
            position="absolute"
            top={segment.y - 1}
            left={widths.rootPaddingX + segment.startX}
            height={1}
          >
            <Text color="black" backgroundColor="#ff9800">{segment.text}</Text>
          </Box>
        ))}
      </>
    )
    : undefined;

  useEffect(() => store.subscribe(setState), [store]);
  useEffect(() => {
    if (!inputEnabled) {
      setInputFocused(false);
      clearSelection();
    }
  }, [clearSelection, inputEnabled]);
  useEffect(() => {
    if (workspace.taskRows === 0) updateTaskLines([]);
  }, [updateTaskLines, workspace.taskRows]);
  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write(mouseCaptureEnabled ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
    return () => {
      stdout.write(MOUSE_TRACKING_OFF);
    };
  }, [mouseCaptureEnabled, stdout]);
  useEffect(() => {
    if (!stdout.isTTY) return;
    const hideInputCursor = () => {
      setInputFocused(false);
      clearSelection();
    };
    stdout.on("resize", hideInputCursor);
    return () => {
      stdout.off("resize", hideInputCursor);
    };
  }, [clearSelection, stdout]);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      if (selection) {
        writeTuiClipboard(stdout, extractTuiSelectionText(selectableLines, selection));
        clearSelection();
      } else {
        onExit();
      }
      return;
    }
    // Terminal mouse reporting and native text selection are mutually
    // exclusive. Ctrl+S toggles a temporary selection mode; terminals that
    // report Shift separately also expose this as Ctrl+Shift+S.
    if (key.ctrl && value.toLowerCase() === "s") {
      setMouseCaptureEnabled((current) => !current);
      setInputFocused(false);
      clearSelection();
      return;
    }
    const mouse = parseSgrMouseEvent(value);
    if (mouse) {
      const isWheel = (mouse.button & 64) !== 0;
      if (isWheel) {
        clearSelection();
        return;
      }
      const isMotion = (mouse.button & 32) !== 0;
      const isPrimaryButton = (mouse.button & 3) === 0;
      const drag = selectionDragRef.current;
      if (drag) {
        const point = resolveSelectionPoint(mouse);
        if (point) drag.focus = point;
        const nextSelection = { anchor: drag.anchor, focus: drag.focus };
        if (mouse.released) {
          selectionDragRef.current = undefined;
          if (drag.focus.x === drag.anchor.x && drag.focus.y === drag.anchor.y) {
            clearSelection();
          } else {
            writeTuiClipboard(stdout, extractTuiSelectionText(selectableLines, nextSelection));
            clearSelection();
          }
        } else if (isMotion && point) {
          if (point.x === drag.anchor.x && point.y === drag.anchor.y) {
            setSelection(undefined);
          } else {
            setSelection(nextSelection);
          }
        }
        return;
      }
      if (!mouse.released && !isMotion && isPrimaryButton) {
        clearSelection();
        const point = resolveSelectionPoint(mouse);
        if (point) {
          selectionDragRef.current = { anchor: point, focus: point };
          setInputFocused(false);
        }
      }
      return;
    }
    if (selection) {
      clearSelection();
    }
    if (key.tab) {
      setTasksOpen((current) => !current);
    }
  });

  return (
    <ScoutShell
      terminalWidth={widths.terminalWidth}
      contentWidth={widths.contentWidth}
      appHeight={appHeight}
      rootPaddingX={widths.rootPaddingX}
      topChromeRows={topChromeRows}
      workspaceRows={workspace.totalRows}
      taskGapRows={workspace.taskGapRows}
      activityGapRows={workspace.activityGapRows}
      promptRows={promptRows}
      topChrome={(
        <TopChrome
          state={state}
          activeTasks={activeTasks}
          compact={compact}
          width={widths.contentWidth}
        />
      )}
      chatPanel={(
        <ChatPanel
          items={chatItems}
          width={widths.contentWidth}
          height={workspace.chatRows}
          startY={chatStartY}
          keyboardActive={!tasksOpen}
          onVisibleLinesChange={updateChatLines}
        />
      )}
      tasksDrawer={workspace.taskRows > 0
        ? (
          <TasksDrawer
            tasks={tasks}
            open={tasksOpen}
            width={widths.contentWidth}
            height={workspace.taskRows}
            startY={tasksStartY}
            onClose={() => setTasksOpen(false)}
            onVisibleLinesChange={updateTaskLines}
          />
        )
        : null}
      activityBar={(
        <ActivityBar
          item={currentActivity}
          width={widths.contentWidth}
          height={workspace.activityRows}
          screenX={widths.rootPaddingX}
          screenY={topChromeRows + workspace.activityOffset}
          onVisibleLinesChange={updateActivityLines}
        />
      )}
      selectionOverlay={selectionOverlay}
      promptInput={inputReady
        ? (
          <PromptInput
            active={inputEnabled}
            focused={inputFocused}
            promptTopY={promptTopY}
            widths={widths}
            cwd={state.runtime.cwd}
            onSubmit={(message) => store.submitInput(message)}
            onExit={onExit}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          />
        )
        : undefined}
    />
  );
}

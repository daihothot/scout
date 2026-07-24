import React, { useEffect, useMemo, useState } from "react";
import { useInput, useStdout, useWindowSize } from "ink";
import {
  ActivityBar,
  resolveActivityBarRows,
} from "./chrome/activity-bar.js";
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

export interface ScoutTuiAppProps {
  store: TuiStore;
  onExit: () => void;
}

const MIN_APP_HEIGHT = 14;
const MOUSE_TRACKING_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_TRACKING_OFF = "\u001b[?1006l\u001b[?1000l";

export function ScoutTuiApp({ store, onExit }: ScoutTuiAppProps) {
  const [state, setState] = useState<TuiState>(() => store.snapshot());
  const [tasksOpen, setTasksOpen] = useState(false);
  const { stdout } = useStdout();
  const { columns, rows } = useWindowSize();
  const widths = resolveTuiWidths(columns);
  const appHeight = Math.max(MIN_APP_HEIGHT, rows - 1);
  const compact = widths.terminalWidth < 68 || rows < 30;
  const inputReady = state.runtime.status === "ready";
  const showLifecycleProgress = Boolean(
    state.lifecycle && state.runtime.status !== "ready",
  );
  const topChromeRows = resolveTopChromeRows(compact, showLifecycleProgress);
  const promptRows = inputReady ? PROMPT_INPUT_ROWS : 0;
  const availableWorkspaceRows = Math.max(1, appHeight - topChromeRows - promptRows);
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
      (maximum, task) => Math.max(maximum, task.planSteps.length),
      0,
    ),
    desiredActivityRows: resolveActivityBarRows(currentActivity, widths.contentWidth),
  });
  const chatStartY = topChromeRows + workspace.chatOffset + 1;
  const tasksStartY = topChromeRows + workspace.tasksOffset + 1;

  useEffect(() => store.subscribe(setState), [store]);
  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write(MOUSE_TRACKING_ON);
    return () => {
      stdout.write(MOUSE_TRACKING_OFF);
    };
  }, [stdout]);

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      onExit();
      return;
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
      workspaceRows={workspace.totalRows}
      taskGapRows={workspace.taskGapRows}
      activityGapRows={workspace.activityGapRows}
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
          />
        )
        : null}
      activityBar={(
        <ActivityBar
          item={currentActivity}
          width={widths.contentWidth}
          height={workspace.activityRows}
        />
      )}
      promptInput={inputReady
        ? (
          <PromptInput
            active={!tasksOpen}
            appHeight={appHeight}
            widths={widths}
            cwd={state.runtime.cwd}
            onSubmit={(message) => store.submitInput(message)}
            onExit={onExit}
          />
        )
        : undefined}
    />
  );
}

import type {
  TuiTaskPlanStep,
  TuiTaskSummary,
} from "./tui-store.js";
import {
  terminalDisplayWidth,
  truncateByDisplayWidth,
} from "./terminal-text.js";

const TASK_STEP_STATUS_COLUMN_WIDTH = 10;

export interface TuiWorkspaceLayout {
  totalRows: number;
  topMarginRows: number;
  sectionGapRows: number;
  coordinatorHeaderOffset: number;
  coordinatorBodyOffset: number;
  coordinatorViewportRows: number;
  taskHeaderOffset?: number;
  taskStepsOffset?: number;
  taskStepRows: number;
  workerHeaderOffset?: number;
  workerBodyOffset?: number;
  workerViewportRows: number;
}

export interface TuiTaskStepWindow {
  start: number;
  steps: TuiTaskPlanStep[];
}

export interface TuiTaskStepDisplay {
  marker: string;
  label: string;
  labelPadding: string;
  status: string;
  statusColumnStart: number;
}

export function resolveTuiWorkspaceLayout(input: {
  availableRows: number;
  hasTask: boolean;
  workerOpen: boolean;
  planStepCount: number;
}): TuiWorkspaceLayout {
  const totalRows = Math.max(1, Math.floor(input.availableRows));
  const topMarginRows = input.hasTask
    ? (totalRows >= 14 ? 1 : 0)
    : (totalRows >= 3 ? 1 : 0);
  const sectionGapRows = input.hasTask && totalRows >= 18 ? 1 : 0;
  const headerRows = 1 + (input.hasTask ? 1 : 0) + (input.workerOpen ? 1 : 0);
  const gapRows = sectionGapRows * ((input.hasTask ? 1 : 0) + (input.workerOpen ? 1 : 0));
  const minimumActivityRows = 1 + (input.workerOpen ? 1 : 0);
  const taskStepCapacity = Math.max(
    0,
    totalRows - topMarginRows - headerRows - gapRows - minimumActivityRows,
  );
  const taskStepRows = input.hasTask
    ? Math.min(Math.max(0, input.planStepCount), taskStepCapacity)
    : 0;
  const activityRows = Math.max(
    minimumActivityRows,
    totalRows - topMarginRows - headerRows - gapRows - taskStepRows,
  );
  const coordinatorViewportRows = input.workerOpen
    ? Math.max(1, Math.floor(activityRows / 2))
    : Math.max(1, activityRows);
  const workerViewportRows = input.workerOpen
    ? Math.max(1, activityRows - coordinatorViewportRows)
    : 0;

  let offset = topMarginRows;
  const coordinatorHeaderOffset = offset;
  offset += 1;
  const coordinatorBodyOffset = offset;
  offset += coordinatorViewportRows;

  let taskHeaderOffset: number | undefined;
  let taskStepsOffset: number | undefined;
  if (input.hasTask) {
    offset += sectionGapRows;
    taskHeaderOffset = offset;
    offset += 1;
    taskStepsOffset = offset;
    offset += taskStepRows;
  }

  let workerHeaderOffset: number | undefined;
  let workerBodyOffset: number | undefined;
  if (input.workerOpen) {
    offset += sectionGapRows;
    workerHeaderOffset = offset;
    offset += 1;
    workerBodyOffset = offset;
  }

  return {
    totalRows,
    topMarginRows,
    sectionGapRows,
    coordinatorHeaderOffset,
    coordinatorBodyOffset,
    coordinatorViewportRows,
    taskHeaderOffset,
    taskStepsOffset,
    taskStepRows,
    workerHeaderOffset,
    workerBodyOffset,
    workerViewportRows,
  };
}

export function selectCurrentTask(tasks: TuiTaskSummary[]): TuiTaskSummary | undefined {
  return [...tasks].sort((left, right) =>
    left.taskSequence - right.taskSequence || left.updatedAt.localeCompare(right.updatedAt)
  ).at(-1);
}

export function isTerminalTaskStatus(status: string | undefined): boolean {
  return status === "complete"
    || status === "blocked"
    || status === "failed"
    || status === "stopped";
}

export function resolveTaskStepWindow(
  steps: TuiTaskPlanStep[],
  capacity: number,
): TuiTaskStepWindow {
  const normalizedCapacity = Math.max(0, Math.floor(capacity));
  if (normalizedCapacity === 0) return { start: 0, steps: [] };
  if (steps.length <= normalizedCapacity) return { start: 0, steps };
  const activeIndex = steps.findIndex((step) => step.status === "inProgress");
  const anchor = activeIndex >= 0 ? activeIndex : steps.length - 1;
  const start = Math.min(
    steps.length - normalizedCapacity,
    Math.max(0, anchor - Math.floor((normalizedCapacity - 1) / 2)),
  );
  return {
    start,
    steps: steps.slice(start, start + normalizedCapacity),
  };
}

export function buildTaskStepDisplay(
  step: TuiTaskPlanStep,
  width: number,
): TuiTaskStepDisplay {
  const normalizedWidth = Math.max(1, Math.floor(width));
  const marker = taskStepMarker(step.status);
  const markerWidth = terminalDisplayWidth(`${marker} `);
  const availableAfterMarker = Math.max(0, normalizedWidth - markerWidth);
  const statusColumnWidth = Math.min(TASK_STEP_STATUS_COLUMN_WIDTH, availableAfterMarker);
  const labelColumnWidth = Math.max(0, availableAfterMarker - statusColumnWidth);
  const label = truncateByDisplayWidth(step.step, labelColumnWidth);
  const labelPadding = " ".repeat(Math.max(
    0,
    labelColumnWidth - terminalDisplayWidth(label),
  ));
  return {
    marker,
    label,
    labelPadding,
    status: truncateByDisplayWidth(step.status, statusColumnWidth),
    statusColumnStart: markerWidth + labelColumnWidth,
  };
}

function taskStepMarker(status: string): string {
  if (status === "completed") return "✓";
  if (status === "inProgress") return "→";
  if (status === "pending") return "✷";
  if (status === "failed" || status === "blocked") return "!";
  return "·";
}

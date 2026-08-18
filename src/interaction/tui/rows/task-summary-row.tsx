import React from "react";
import { Box, Text } from "ink";
import type { TuiTaskPlanStep, TuiTaskTurn } from "../tui-store.js";
import type { TuiTaskDrawerItem } from "../selectors/task-summaries.js";
import { planStepMarker, taskMarker } from "../markers.js";
import { roleColor, statusColor } from "../theme.js";
import {
  terminalDisplayWidth,
  truncateByDisplayWidth,
} from "../terminal-text.js";

const TASK_STEP_STATUS_COLUMN_WIDTH = 10;

/** Renders one task summary with selection, role, and status markers. */
export function TaskSummaryRow({ task, selected, width }: {
  task: TuiTaskDrawerItem;
  selected: boolean;
  width: number;
}) {
  const display = buildTaskSummaryDisplay(task, selected, width);
  return (
    <Box width={width} justifyContent="space-between" flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={selected ? "cyan" : statusColor(display.status)} bold={selected}>{display.visibleMarker}</Text>
        <Text>{display.markerGap}</Text>
        <Text color={roleColor(task.role)} bold={selected}>{display.title}</Text>
      </Text>
      <Text color={statusColor(display.status)} bold={selected}>{display.status}</Text>
    </Box>
  );
}

/** Builds the complete plain row used by both rendering and text selection. */
export function buildTaskSummaryText(
  task: TuiTaskDrawerItem,
  selected: boolean,
  width: number,
): string {
  const display = buildTaskSummaryDisplay(task, selected, width);
  const left = `${display.visibleMarker}${display.markerGap}${display.title}`;
  return `${left}${" ".repeat(Math.max(0, width - terminalDisplayWidth(left) - terminalDisplayWidth(display.visibleStatus)))}${display.visibleStatus}`;
}

function buildTaskSummaryDisplay(task: TuiTaskDrawerItem, selected: boolean, width: number): {
  status: string;
  visibleStatus: string;
  visibleMarker: string;
  markerGap: string;
  title: string;
} {
  const status = task.status ?? "unknown";
  const marker = taskMarker(status, selected);
  const statusWidth = Math.min(width, terminalDisplayWidth(status));
  const visibleStatus = truncateByDisplayWidth(status, statusWidth);
  const titleWidth = Math.max(0, width - statusWidth - (statusWidth > 0 ? 1 : 0));
  const markerWidth = Math.min(titleWidth, terminalDisplayWidth(marker));
  const visibleMarker = truncateByDisplayWidth(marker, markerWidth);
  const markerGap = titleWidth > markerWidth ? " " : "";
  const title = truncateByDisplayWidth(
    `${task.taskId}  ${task.role ?? task.agentId ?? "worker"}  ${task.description ?? ""}`,
    Math.max(0, titleWidth - markerWidth - terminalDisplayWidth(markerGap)),
  );
  return { status, visibleStatus, visibleMarker, markerGap, title };
}

/** Renders one plan step aligned to the drawer's status column. */
export function TaskPlanStepRow({ step, width, indent = 2 }: {
  step: TuiTaskPlanStep;
  width: number;
  indent?: number;
}) {
  const display = buildTaskStepDisplay(step, Math.max(1, width - indent));
  return (
    <Text wrap="truncate-end">
      <Text>{" ".repeat(indent)}</Text>
      <Text color={statusColor(step.status)}>{display.marker} </Text>
      <Text>{display.label}{display.labelPadding}</Text>
      <Text color={statusColor(step.status)}>{display.status}</Text>
    </Text>
  );
}

/** Builds the complete plain plan-step row used by text selection. */
export function buildTaskPlanStepText(
  step: TuiTaskPlanStep,
  width: number,
  indent = 2,
): string {
  const display = buildTaskStepDisplay(step, Math.max(1, width - indent));
  return `${" ".repeat(indent)}${display.marker} ${display.label}${display.labelPadding}${display.status}`;
}

/** Renders a turn boundary so interrupted and resumed plans remain distinct. */
export function TaskTurnRow({ turn, turnIndex, width }: {
  turn: TuiTaskTurn;
  turnIndex: number;
  width: number;
}) {
  const display = buildTaskTurnDisplay(turn.status, turnIndex, width);
  return (
    <Box width={width} justifyContent="space-between" flexShrink={0}>
      <Text color={statusColor(display.status)} dimColor={display.status === "unknown"} wrap="truncate-end">
        {display.title}
      </Text>
      <Text color={statusColor(display.status)}>{display.statusLabel}</Text>
    </Box>
  );
}

/** Builds the complete plain turn boundary row used by text selection. */
export function buildTaskTurnText(
  status: string | undefined,
  turnIndex: number,
  width: number,
): string {
  const display = buildTaskTurnDisplay(status, turnIndex, width);
  const left = display.title;
  return `${left}${" ".repeat(Math.max(0, width - terminalDisplayWidth(left) - terminalDisplayWidth(display.statusLabel)))}${display.statusLabel}`;
}

function buildTaskTurnDisplay(statusValue: string | undefined, turnIndex: number, width: number): {
  status: string;
  statusLabel: string;
  title: string;
} {
  const status = statusValue ?? "unknown";
  const label = `  turn ${turnIndex + 1}`;
  const statusLabel = ` ${status}`;
  const statusWidth = Math.min(width, terminalDisplayWidth(statusLabel));
  const visibleStatus = truncateByDisplayWidth(statusLabel, statusWidth);
  const title = truncateByDisplayWidth(
    label,
    Math.max(0, width - statusWidth),
  );
  return { status, statusLabel: visibleStatus, title };
}

/** Computes the marker, label padding, and clipped status for one plan step. */
export function buildTaskStepDisplay(
  step: TuiTaskPlanStep,
  width: number,
): {
  marker: string;
  label: string;
  labelPadding: string;
  status: string;
  statusColumnStart: number;
} {
  const normalizedWidth = Math.max(1, Math.floor(width));
  const marker = planStepMarker(step.status);
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

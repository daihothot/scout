import React from "react";
import { Box, Text } from "ink";
import type { TuiTaskPlanStep } from "../tui-store.js";
import type { TuiTaskDrawerItem } from "../selectors/task-summaries.js";
import { planStepMarker, taskMarker } from "../markers.js";
import { roleColor, statusColor } from "../theme.js";
import {
  terminalDisplayWidth,
  truncateByDisplayWidth,
} from "../terminal-text.js";

const TASK_STEP_STATUS_COLUMN_WIDTH = 10;

export function TaskSummaryRow({ task, selected, width }: {
  task: TuiTaskDrawerItem;
  selected: boolean;
  width: number;
}) {
  const status = task.status ?? "unknown";
  const marker = taskMarker(status, selected);
  const statusWidth = Math.min(width, terminalDisplayWidth(status));
  const titleWidth = Math.max(0, width - statusWidth - (statusWidth > 0 ? 1 : 0));
  const markerWidth = Math.min(titleWidth, terminalDisplayWidth(marker));
  const visibleMarker = truncateByDisplayWidth(marker, markerWidth);
  const markerGap = titleWidth > markerWidth ? " " : "";
  const title = truncateByDisplayWidth(
    `${task.taskId}  ${task.role ?? task.agentId ?? "worker"}  ${task.description ?? ""}`,
    Math.max(0, titleWidth - markerWidth - terminalDisplayWidth(markerGap)),
  );
  return (
    <Box width={width} justifyContent="space-between" flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={selected ? "cyan" : statusColor(status)} bold={selected}>{visibleMarker}</Text>
        <Text>{markerGap}</Text>
        <Text color={roleColor(task.role)} bold={selected}>{title}</Text>
      </Text>
      <Text color={statusColor(status)} bold={selected}>{status}</Text>
    </Box>
  );
}

export function TaskPlanStepRow({ step, width }: {
  step: TuiTaskPlanStep;
  width: number;
}) {
  const display = buildTaskStepDisplay(step, Math.max(1, width - 2));
  return (
    <Text wrap="truncate-end">
      <Text>  </Text>
      <Text color={statusColor(step.status)}>{display.marker} </Text>
      <Text>{display.label}{display.labelPadding}</Text>
      <Text color={statusColor(step.status)}>{display.status}</Text>
    </Text>
  );
}

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

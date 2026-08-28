import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  mouseWheelDelta,
  parseSgrMouseEvent,
} from "../activity-viewport.js";
import {
  isActiveTaskStatus,
  type TuiTaskDrawerItem,
} from "../selectors/task-summaries.js";
import {
  buildTaskPlanStepText,
  buildTaskSummaryText,
  buildTaskTurnText,
  TaskPlanStepRow,
  TaskSummaryRow,
  TaskTurnRow,
} from "../rows/task-summary-row.js";
import {
  truncateByDisplayWidth,
} from "../terminal-text.js";

type TaskDrawerVisualRow =
  | { kind: "task"; id: string; task: TuiTaskDrawerItem; taskIndex: number }
  | { kind: "turn"; id: string; turn: TuiTaskDrawerItem["turns"][number]; turnIndex: number }
  | { kind: "step"; id: string; step: TuiTaskDrawerItem["turns"][number]["planSteps"][number] };

/** Keyboard- and mouse-navigable task drawer with optional plan expansion. */
export function TasksDrawer({
  tasks,
  open,
  width,
  height,
  startY,
  onClose,
  onVisibleLinesChange,
}: {
  tasks: TuiTaskDrawerItem[];
  open: boolean;
  width: number;
  height: number;
  startY: number;
  onClose: () => void;
  onVisibleLinesChange?: (lines: string[]) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedTaskId, setExpandedTaskId] = useState<string>();
  const [requestedScrollTop, setRequestedScrollTop] = useState<number>();

  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, tasks.length - 1)));
    setExpandedTaskId((current) => current && tasks.some((task) => task.taskId === current)
      ? current
      : undefined);
  }, [tasks]);

  const moveSelection = (delta: number) => {
    setRequestedScrollTop(undefined);
    setSelectedIndex((current) => Math.max(0, Math.min(tasks.length - 1, current + delta)));
  };

  const visualRows = useMemo(
    () => buildTaskDrawerRows(tasks, expandedTaskId),
    [expandedTaskId, tasks],
  );
  const bodyRows = Math.max(0, height - 1);
  const selectedVisualIndex = visualRows.findIndex((row) =>
    row.kind === "task" && row.taskIndex === selectedIndex
  );
  const scrollTop = resolveTaskDrawerScrollTop(
    visualRows.length,
    bodyRows,
    selectedVisualIndex,
    requestedScrollTop,
  );

  useEffect(() => {
    setRequestedScrollTop((current) => current === undefined
      ? undefined
      : resolveTaskDrawerScrollTop(
        visualRows.length,
        bodyRows,
        selectedVisualIndex,
        current,
      ));
  }, [bodyRows, selectedVisualIndex, visualRows.length]);

  const scrollBy = (delta: number) => {
    setRequestedScrollTop((current) => {
      const currentTop = resolveTaskDrawerScrollTop(
        visualRows.length,
        bodyRows,
        selectedVisualIndex,
        current,
      );
      return resolveTaskDrawerScrollTop(
        visualRows.length,
        bodyRows,
        selectedVisualIndex,
        currentTop + delta,
      );
    });
  };

  useInput((value, key) => {
    if (!open) return;
    const mouse = parseSgrMouseEvent(value);
    if (mouse && mouse.y >= startY && mouse.y < startY + height) {
      const delta = mouseWheelDelta(mouse, 1);
      if (delta !== undefined) scrollBy(delta);
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
    if (key.pageUp) {
      scrollBy(-Math.max(1, bodyRows));
      return;
    }
    if (key.pageDown) {
      scrollBy(Math.max(1, bodyRows));
      return;
    }
    if (key.upArrow) {
      moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      moveSelection(1);
      return;
    }
    if (key.return) {
      const selected = tasks[selectedIndex];
      if (!selected) return;
      setRequestedScrollTop(undefined);
      setExpandedTaskId((current) => current === selected.taskId ? undefined : selected.taskId);
    }
  });

  const visibleRows = open ? visualRows.slice(scrollTop, scrollTop + bodyRows) : [];
  const visibleLineTexts = useMemo(
    () => visibleRows.map((row) => row.kind === "task"
      ? buildTaskSummaryText(row.task, row.taskIndex === selectedIndex, width)
      : row.kind === "turn"
        ? buildTaskTurnText(row.turn.status, row.turnIndex, width)
        : buildTaskPlanStepText(row.step, width, 4)),
    [bodyRows, open, selectedIndex, scrollTop, visualRows, width],
  );
  const selectableLineTexts = useMemo(() => {
    if (height === 0) return [];
    if (!open) return [buildCollapsedTaskSummary(tasks, width)];
    const headerLeft = "Tasks";
    const headerRight = "Esc close";
    const headerGap = " ".repeat(Math.max(
      0,
      width - headerLeft.length - headerRight.length,
    ));
    const body = tasks.length === 0
      ? ["No assigned tasks."]
      : visibleLineTexts;
    return [`${headerLeft}${headerGap}${headerRight}`, ...body].slice(0, height);
  }, [height, open, tasks, visibleLineTexts, width]);

  useEffect(() => {
    onVisibleLinesChange?.(selectableLineTexts);
  }, [onVisibleLinesChange, selectableLineTexts]);

  if (!open) {
    return (
      <Box width={width} height={height} flexShrink={0} overflow="hidden">
        <Text wrap="truncate-end">{buildCollapsedTaskSummary(tasks, width)}</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      flexShrink={0}
      overflow="hidden"
    >
      <Box width={width} justifyContent="space-between" flexShrink={0}>
        <Text color="cyan" bold>Tasks</Text>
        <Text dimColor>Esc close</Text>
      </Box>
      {tasks.length === 0
        ? <Text dimColor>No assigned tasks.</Text>
        : visibleRows.map((row) => row.kind === "task"
          ? (
            <TaskSummaryRow
              key={row.id}
              task={row.task}
              selected={row.taskIndex === selectedIndex}
              width={width}
            />
          )
          : row.kind === "turn"
            ? <TaskTurnRow key={row.id} turn={row.turn} turnIndex={row.turnIndex} width={width} />
            : <TaskPlanStepRow key={row.id} step={row.step} width={width} indent={4} />)}
    </Box>
  );
}

/** Builds the collapsed one-line task summary for compact layouts. */
export function buildCollapsedTaskSummary(
  tasks: TuiTaskDrawerItem[],
  width: number,
): string {
  const activeTasks = tasks.filter((task) => isActiveTaskStatus(task.status));
  const archivedTaskCount = tasks.filter((task) => task.status === "archived").length;
  const taskDetails = tasks
    .filter((task) => task.status !== "archived")
    .map((task) => {
      const sequence = task.taskId.match(/-task-(\d+)$/)?.[1];
      const role = (task.role ?? "worker")
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 5)
        .toUpperCase() || "ROLE";
      return `${role}:${sequence ? `t-${sequence}` : task.taskId} ${task.status ?? "unknown"}`;
    })
    .join(" · ");
  const archivedSummary = archivedTaskCount > 0 ? `${archivedTaskCount} archived` : "";
  const details = [taskDetails, archivedSummary].filter(Boolean).join(" · ");
  return truncateByDisplayWidth(
    `▸ Tasks  ${activeTasks.length} active${details ? ` · ${details}` : ""}`,
    width,
  );
}

function buildTaskDrawerRows(
  tasks: TuiTaskDrawerItem[],
  expandedTaskId: string | undefined,
): TaskDrawerVisualRow[] {
  return tasks.flatMap((task, taskIndex): TaskDrawerVisualRow[] => [
    { kind: "task", id: `task:${task.taskId}`, task, taskIndex },
    ...(task.taskId === expandedTaskId
      ? task.turns.flatMap((turn, turnIndex) => [
        {
          kind: "turn" as const,
          id: `task:${task.taskId}:turn:${turnIndex}`,
          turn,
          turnIndex,
        },
        ...turn.planSteps.map((step, stepIndex) => ({
          kind: "step" as const,
          id: `task:${task.taskId}:turn:${turnIndex}:step:${stepIndex}`,
          step,
        })),
      ])
      : []),
  ]);
}

/** Resolves the drawer scroll offset around the selected task row. */
export function resolveTaskDrawerScrollTop(
  totalRows: number,
  viewportRows: number,
  selectedRow: number,
  requestedTop?: number,
): number {
  if (viewportRows <= 0 || totalRows <= viewportRows) return 0;
  const maximumTop = totalRows - viewportRows;
  if (requestedTop !== undefined) {
    return Math.min(maximumTop, Math.max(0, requestedTop));
  }
  const anchor = Math.max(0, selectedRow);
  return Math.min(
    maximumTop,
    Math.max(0, anchor - Math.floor((viewportRows - 1) / 2)),
  );
}

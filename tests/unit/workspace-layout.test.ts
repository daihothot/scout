import assert from "node:assert/strict";
import test from "node:test";
import { buildCollapsedTaskSummary } from "../../src/interaction/tui/panels/tasks-drawer.js";
import { buildTaskStepDisplay } from "../../src/interaction/tui/rows/task-summary-row.js";
import { selectTaskSummaries } from "../../src/interaction/tui/selectors/task-summaries.js";
import { terminalDisplayWidth } from "../../src/interaction/tui/terminal-text.js";
import {
  resolveTuiWidths,
  resolveTuiWorkspaceLayout,
} from "../../src/interaction/tui/workspace-layout.js";
import type { TuiTaskPlanStep } from "../../src/interaction/tui/tui-store.js";
import type { TuiState } from "../../src/interaction/tui/tui-store.js";

test("workspace keeps Chat full width above the collapsed task and activity rows", () => {
  const layout = resolveTuiWorkspaceLayout({
    availableRows: 12,
    drawerOpen: false,
    taskCount: 3,
    desiredActivityRows: 1,
  });

  assert.deepEqual(layout, {
    totalRows: 12,
    chatOffset: 0,
    chatRows: 9,
    tasksOffset: 9,
    taskRows: 1,
    activityGapRows: 1,
    activityOffset: 11,
    activityRows: 1,
  });
});

test("expanded task drawer takes bounded bottom rows without removing Chat", () => {
  const layout = resolveTuiWorkspaceLayout({
    availableRows: 12,
    drawerOpen: true,
    taskCount: 3,
    desiredActivityRows: 1,
  });

  assert.deepEqual(layout, {
    totalRows: 12,
    chatOffset: 0,
    chatRows: 2,
    tasksOffset: 2,
    taskRows: 8,
    activityGapRows: 1,
    activityOffset: 11,
    activityRows: 1,
  });
});

test("short workspaces preserve Chat before optional chrome rows", () => {
  assert.deepEqual(resolveTuiWorkspaceLayout({
    availableRows: 2,
    drawerOpen: true,
    taskCount: 3,
    desiredActivityRows: 1,
  }), {
    totalRows: 2,
    chatOffset: 0,
    chatRows: 1,
    tasksOffset: 1,
    taskRows: 1,
    activityGapRows: 0,
    activityOffset: 2,
    activityRows: 0,
  });
});

test("workspace reserves wrapped Activity rows below the task gap", () => {
  assert.deepEqual(resolveTuiWorkspaceLayout({
    availableRows: 12,
    drawerOpen: false,
    taskCount: 1,
    desiredActivityRows: 3,
  }), {
    totalRows: 12,
    chatOffset: 0,
    chatRows: 7,
    tasksOffset: 7,
    taskRows: 1,
    activityGapRows: 1,
    activityOffset: 9,
    activityRows: 3,
  });
});

test("task drawer keeps archived tasks after current tasks and summarizes their count", () => {
  const state: TuiState = {
    runtime: {
      cwd: "/repo/scout",
      version: "0.1.0",
      model: "gpt-5.5",
      reasoningEffort: "high",
      status: "ready",
    },
    logs: [],
    activities: [],
    turnActivities: [],
    tasks: [
      {
        taskId: "researcher-task-0001",
        taskSequence: 1,
        role: "researcher",
        status: "archived",
        description: "旧研究任务",
        updatedAt: "2026-07-10T00:00:01.000Z",
        planSteps: [],
      },
      {
        taskId: "validator-task-0001",
        taskSequence: 1,
        role: "validator",
        status: "running",
        description: "检查研究结果",
        updatedAt: "2026-07-10T00:00:02.000Z",
        planSteps: [],
      },
    ],
  };

  const tasks = selectTaskSummaries(state);
  assert.deepEqual(tasks.map((task) => task.status), ["running", "archived"]);
  assert.equal(
    buildCollapsedTaskSummary(tasks, 120),
    "▸ Tasks  1 active · VAL:t-0001 running · 1 archived",
  );
});

test("task step statuses start in one aligned column", () => {
  const steps: TuiTaskPlanStep[] = [
    { step: "Read skills", status: "inProgress" },
    { step: "Locate BDD", status: "completed" },
    { step: "Write artifact", status: "pending" },
  ];
  const rows = steps.map((step) => buildTaskStepDisplay(step, 46));

  assert.deepEqual(rows.map((row) => row.statusColumnStart), [36, 36, 36]);
  assert.deepEqual(rows.map((row) => row.marker), ["→", "✓", "·"]);
  assert.equal(rows[0]?.status, "inProgress");
  assert.ok(rows.every((row) =>
    terminalDisplayWidth(`${row.marker} ${row.label}${row.labelPadding}${row.status}`) <= 46
  ));
});

test("TUI widths derive every horizontal region from terminal columns", () => {
  assert.deepEqual(resolveTuiWidths(20), {
    terminalWidth: 20,
    rootPaddingX: 0,
    contentWidth: 20,
    inputValueWidth: 14,
  });
  assert.deepEqual(resolveTuiWidths(40), {
    terminalWidth: 40,
    rootPaddingX: 1,
    contentWidth: 38,
    inputValueWidth: 32,
  });
  assert.deepEqual(resolveTuiWidths(80), {
    terminalWidth: 80,
    rootPaddingX: 2,
    contentWidth: 76,
    inputValueWidth: 70,
  });
});

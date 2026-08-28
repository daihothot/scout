import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCollapsedTaskSummary,
  resolveTaskDrawerScrollTop,
} from "../../src/interaction/tui/panels/tasks-drawer.js";
import { buildTaskStepDisplay } from "../../src/interaction/tui/rows/task-summary-row.js";
import { selectTaskSummaries } from "../../src/interaction/tui/selectors/task-summaries.js";
import { selectCoordinatorSteps } from "../../src/interaction/tui/selectors/coordinator-steps.js";
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
    taskPlanStepRows: 4,
    desiredActivityRows: 1,
  });

  assert.deepEqual(layout, {
    totalRows: 12,
    chatOffset: 0,
    chatRows: 8,
    taskGapRows: 1,
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
    taskPlanStepRows: 4,
    desiredActivityRows: 1,
  });

  assert.deepEqual(layout, {
    totalRows: 12,
    chatOffset: 0,
    chatRows: 1,
    taskGapRows: 1,
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
    taskPlanStepRows: 5,
    desiredActivityRows: 1,
  }), {
    totalRows: 2,
    chatOffset: 0,
    chatRows: 1,
    taskGapRows: 0,
    tasksOffset: 1,
    taskRows: 1,
    activityGapRows: 0,
    activityOffset: 2,
    activityRows: 0,
  });
});

test("empty workspace leaves the bottom prompt slot available", () => {
  assert.deepEqual(resolveTuiWorkspaceLayout({
    availableRows: 0,
    drawerOpen: false,
    taskCount: 0,
    taskPlanStepRows: 0,
    desiredActivityRows: 1,
  }), {
    totalRows: 0,
    chatOffset: 0,
    chatRows: 0,
    taskGapRows: 0,
    tasksOffset: 0,
    taskRows: 0,
    activityGapRows: 0,
    activityOffset: 0,
    activityRows: 0,
  });
});

test("workspace reserves wrapped Activity rows below the task gap", () => {
  assert.deepEqual(resolveTuiWorkspaceLayout({
    availableRows: 12,
    drawerOpen: false,
    taskCount: 1,
    taskPlanStepRows: 5,
    desiredActivityRows: 3,
  }), {
    totalRows: 12,
    chatOffset: 0,
    chatRows: 6,
    taskGapRows: 1,
    tasksOffset: 7,
    taskRows: 1,
    activityGapRows: 1,
    activityOffset: 9,
    activityRows: 3,
  });
});

test("expanded task drawer budgets every current plan step when space is available", () => {
  assert.deepEqual(resolveTuiWorkspaceLayout({
    availableRows: 15,
    drawerOpen: true,
    taskCount: 1,
    taskPlanStepRows: 5,
    desiredActivityRows: 1,
  }), {
    totalRows: 15,
    chatOffset: 0,
    chatRows: 5,
    taskGapRows: 1,
    tasksOffset: 6,
    taskRows: 7,
    activityGapRows: 1,
    activityOffset: 14,
    activityRows: 1,
  });
});

test("task drawer viewport can reach plan rows clipped by terminal height", () => {
  assert.equal(resolveTaskDrawerScrollTop(6, 5, 0), 0);
  assert.equal(resolveTaskDrawerScrollTop(6, 5, 0, 1), 1);
  assert.equal(resolveTaskDrawerScrollTop(6, 5, 0, 99), 1);
  assert.equal(resolveTaskDrawerScrollTop(10, 3, 8), 7);
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
        turns: [],
      },
      {
        taskId: "validator-task-0001",
        taskSequence: 1,
        role: "validator",
        status: "running",
        description: "检查研究结果",
        updatedAt: "2026-07-10T00:00:02.000Z",
        turns: [],
      },
    ],
    steps: [{
      stepId: "coordinator-step-hidden-from-tasks",
      agentId: "coordinator",
      turnId: "coordinator-turn-hidden-from-tasks",
      status: "completed",
      prompt: "Coordinate without entering the Tasks drawer.",
      toolCallIds: [],
      humanInputReferences: [],
      plan: {
        turnId: "coordinator-turn-hidden-from-tasks",
        explanation: "Coordinator-only plan.",
        steps: [{ step: "Observe workers", status: "completed", raw: {} }],
      },
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }],
  };

  const tasks = selectTaskSummaries(state);
  assert.deepEqual(tasks.map((task) => task.status), ["running", "archived"]);
  assert.equal(
    buildCollapsedTaskSummary(tasks, 120),
    "▸ Tasks  1 active · VALID:t-0001 running · 1 archived",
  );
  assert.doesNotMatch(buildCollapsedTaskSummary(tasks, 120), /Coordinator|COORD|Observe workers/);
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

test("Coordinator steps remain available for a future independent drawer", () => {
  const state: TuiState = {
    runtime: {
      cwd: "/repo/scout",
      version: "0.1.0",
      model: "gpt-5.5",
      reasoningEffort: "high",
      status: "ready",
    },
    logs: [],
    tasks: [],
    steps: [{
      stepId: "coordinator-step-0001",
      agentId: "coordinator",
      turnId: "turn-1",
      status: "completed",
      prompt: "coordinate",
      toolCallIds: [],
      humanInputReferences: [],
      plan: {
        explanation: "Review the worker result.",
        steps: [
          { step: "Read handoff", status: "completed", raw: {} },
          { step: "Decide next action", status: "inProgress", raw: {} },
        ],
      },
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }],
    activities: [],
    turnActivities: [],
  };

  assert.deepEqual(selectCoordinatorSteps(state), [{
    stepId: "coordinator-step-0001",
    turnId: "turn-1",
    status: "completed",
    updatedAt: "2026-07-10T00:00:02.000Z",
    planExplanation: "Review the worker result.",
    planSteps: [
      { step: "Read handoff", status: "completed" },
      { step: "Decide next action", status: "inProgress" },
    ],
  }]);
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

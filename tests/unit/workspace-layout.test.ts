import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskStepDisplay,
  isTerminalTaskStatus,
  resolveTaskStepWindow,
  resolveTuiWorkspaceLayout,
  selectCurrentTask,
} from "../../src/interaction/tui/workspace-layout.js";
import { terminalDisplayWidth } from "../../src/interaction/tui/terminal-text.js";
import type {
  TuiTaskPlanStep,
  TuiTaskSummary,
} from "../../src/interaction/tui/tui-store.js";

test("workspace gives Coordinator the full viewport when no task exists", () => {
  const layout = resolveTuiWorkspaceLayout({
    availableRows: 12,
    hasTask: false,
    workerOpen: false,
    planStepCount: 0,
  });

  assert.equal(layout.topMarginRows, 1);
  assert.equal(layout.coordinatorHeaderOffset, 1);
  assert.equal(layout.coordinatorBodyOffset, 2);
  assert.equal(layout.coordinatorViewportRows, 10);
  assert.equal(layout.taskHeaderOffset, undefined);
  assert.equal(layout.workerHeaderOffset, undefined);
});

test("workspace fits Coordinator, five task steps and Worker into twelve rows", () => {
  const layout = resolveTuiWorkspaceLayout({
    availableRows: 12,
    hasTask: true,
    workerOpen: true,
    planStepCount: 5,
  });

  assert.deepEqual(layout, {
    totalRows: 12,
    topMarginRows: 0,
    sectionGapRows: 0,
    coordinatorHeaderOffset: 0,
    coordinatorBodyOffset: 1,
    coordinatorViewportRows: 2,
    taskHeaderOffset: 3,
    taskStepsOffset: 4,
    taskStepRows: 5,
    workerHeaderOffset: 9,
    workerBodyOffset: 10,
    workerViewportRows: 2,
  });
});

test("closed Worker activity keeps its task plan and returns remaining rows to Coordinator", () => {
  const layout = resolveTuiWorkspaceLayout({
    availableRows: 12,
    hasTask: true,
    workerOpen: false,
    planStepCount: 5,
  });

  assert.equal(layout.coordinatorViewportRows, 5);
  assert.equal(layout.taskStepRows, 5);
  assert.equal(layout.workerViewportRows, 0);
  assert.equal(layout.workerHeaderOffset, undefined);
});

test("task step window follows the in-progress step when height is constrained", () => {
  const steps = Array.from({ length: 8 }, (_, index): TuiTaskPlanStep => ({
    step: `Step ${index + 1}`,
    status: index === 5 ? "inProgress" : index < 5 ? "completed" : "pending",
  }));

  const window = resolveTaskStepWindow(steps, 4);
  assert.equal(window.start, 4);
  assert.deepEqual(window.steps.map((step) => step.step), [
    "Step 5",
    "Step 6",
    "Step 7",
    "Step 8",
  ]);
});

test("task step statuses start in one aligned column", () => {
  const steps: TuiTaskPlanStep[] = [
    { step: "Read skills", status: "inProgress" },
    { step: "Locate BDD", status: "completed" },
    { step: "Write artifact", status: "pending" },
  ];
  const rows = steps.map((step) => buildTaskStepDisplay(step, 48));

  assert.deepEqual(rows.map((row) => row.statusColumnStart), [38, 38, 38]);
  assert.deepEqual(rows.map((row) => row.marker), ["→", "✓", "✷"]);
  assert.equal(rows[0]?.status, "inProgress");
  assert.ok(rows.every((row) =>
    terminalDisplayWidth(`${row.marker} ${row.label}${row.labelPadding}${row.status}`) <= 48
  ));
});

test("current task selection follows serial task sequence", () => {
  const tasks = [taskSummary(1, "done"), taskSummary(3, "running"), taskSummary(2, "done")];
  assert.equal(selectCurrentTask(tasks)?.taskId, "task-3");
  assert.equal(isTerminalTaskStatus("done"), false);
  assert.equal(isTerminalTaskStatus("stopped"), true);
  assert.equal(isTerminalTaskStatus("running"), false);
});

function taskSummary(taskSequence: number, status: string): TuiTaskSummary {
  return {
    taskId: `task-${taskSequence}`,
    taskSequence,
    agentId: "researcher",
    role: "researcher",
    status,
    description: `Task ${taskSequence}`,
    updatedAt: `2026-07-10T00:00:0${taskSequence}.000Z`,
    planSteps: [],
  };
}

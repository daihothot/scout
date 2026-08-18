import { terminalDisplayWidth } from "./terminal-text.js";

const ROOT_PADDING_X = 2;
const INPUT_BORDER_WIDTH = 1;
const INPUT_PADDING_X = 1;
const INPUT_PROMPT = "› ";

/** Width budget shared by the shell, chat, drawer, and prompt. */
export interface TuiWidths {
  terminalWidth: number;
  rootPaddingX: number;
  contentWidth: number;
  inputValueWidth: number;
}

/** Row allocation for the visible TUI regions. */
export interface TuiWorkspaceLayout {
  totalRows: number;
  chatOffset: number;
  chatRows: number;
  taskGapRows: number;
  tasksOffset: number;
  taskRows: number;
  activityGapRows: number;
  activityOffset: number;
  activityRows: number;
}

/** Computes width budgets from the current terminal column count. */
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

/** Allocates chat, task, and activity rows without exceeding the viewport. */
export function resolveTuiWorkspaceLayout(input: {
  availableRows: number;
  drawerOpen: boolean;
  taskCount: number;
  taskPlanStepRows: number;
  desiredActivityRows: number;
}): TuiWorkspaceLayout {
  const totalRows = Math.max(0, Math.floor(input.availableRows));
  if (totalRows === 0) {
    return {
      totalRows: 0,
      chatOffset: 0,
      chatRows: 0,
      taskGapRows: 0,
      tasksOffset: 0,
      taskRows: 0,
      activityGapRows: 0,
      activityOffset: 0,
      activityRows: 0,
    };
  }
  const minimumTaskRows = totalRows >= 2 ? 1 : 0;
  const taskGapRows = totalRows >= 4 ? 1 : 0;
  const activityGapRows = totalRows >= 5 ? 1 : 0;
  const maximumActivityRows = Math.max(
    0,
    totalRows - minimumTaskRows - taskGapRows - activityGapRows - 1,
  );
  const activityRows = totalRows >= 3
    ? Math.min(maximumActivityRows, Math.max(1, input.desiredActivityRows))
    : 0;
  const maximumTaskRows = Math.max(
    0,
    totalRows - activityRows - taskGapRows - activityGapRows - 1,
  );
  const desiredTaskRows = input.drawerOpen
    ? 1 + Math.max(1, input.taskCount) + Math.max(0, input.taskPlanStepRows)
    : minimumTaskRows;
  const taskRows = Math.min(maximumTaskRows, Math.max(minimumTaskRows, desiredTaskRows));
  const chatRows = Math.max(
    1,
    totalRows - taskRows - taskGapRows - activityGapRows - activityRows,
  );
  const tasksOffset = chatRows + taskGapRows;
  const activityOffset = tasksOffset + taskRows + activityGapRows;
  return {
    totalRows,
    chatOffset: 0,
    chatRows,
    taskGapRows,
    tasksOffset,
    taskRows,
    activityGapRows,
    activityOffset,
    activityRows,
  };
}

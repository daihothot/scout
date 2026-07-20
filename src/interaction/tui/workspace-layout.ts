import { terminalDisplayWidth } from "./terminal-text.js";

const ROOT_PADDING_X = 2;
const INPUT_BORDER_WIDTH = 1;
const INPUT_PADDING_X = 1;
const INPUT_PROMPT = "> ";
const OPEN_DRAWER_STEP_ROWS = 4;

export interface TuiWidths {
  terminalWidth: number;
  rootPaddingX: number;
  contentWidth: number;
  inputValueWidth: number;
}

export interface TuiWorkspaceLayout {
  totalRows: number;
  chatOffset: number;
  chatRows: number;
  tasksOffset: number;
  taskRows: number;
  activityGapRows: number;
  activityOffset: number;
  activityRows: number;
}

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

export function resolveTuiWorkspaceLayout(input: {
  availableRows: number;
  drawerOpen: boolean;
  taskCount: number;
  desiredActivityRows: number;
}): TuiWorkspaceLayout {
  const totalRows = Math.max(1, Math.floor(input.availableRows));
  const minimumTaskRows = totalRows >= 2 ? 1 : 0;
  const activityGapRows = totalRows >= 4 ? 1 : 0;
  const maximumActivityRows = Math.max(
    0,
    totalRows - minimumTaskRows - activityGapRows - 1,
  );
  const activityRows = totalRows >= 3
    ? Math.min(maximumActivityRows, Math.max(1, input.desiredActivityRows))
    : 0;
  const maximumTaskRows = Math.max(
    0,
    totalRows - activityRows - activityGapRows - 1,
  );
  const desiredTaskRows = input.drawerOpen
    ? 1 + Math.max(1, input.taskCount) + OPEN_DRAWER_STEP_ROWS
    : minimumTaskRows;
  const taskRows = Math.min(maximumTaskRows, Math.max(minimumTaskRows, desiredTaskRows));
  const chatRows = Math.max(1, totalRows - taskRows - activityGapRows - activityRows);
  const tasksOffset = chatRows;
  const activityOffset = tasksOffset + taskRows + activityGapRows;
  return {
    totalRows,
    chatOffset: 0,
    chatRows,
    tasksOffset,
    taskRows,
    activityGapRows,
    activityOffset,
    activityRows,
  };
}

import React, { type ReactNode } from "react";
import { Box } from "ink";

/** Composes top chrome, chat, task drawer, activity, and prompt regions. */
export function ScoutShell({
  terminalWidth,
  contentWidth,
  appHeight,
  rootPaddingX,
  topChrome,
  chatPanel,
  tasksDrawer,
  activityBar,
  taskGapRows,
  activityGapRows,
  promptInput,
  workspaceRows,
}: {
  terminalWidth: number;
  contentWidth: number;
  appHeight: number;
  rootPaddingX: number;
  topChrome: ReactNode;
  chatPanel: ReactNode;
  tasksDrawer: ReactNode;
  activityBar: ReactNode;
  taskGapRows: number;
  activityGapRows: number;
  promptInput?: ReactNode;
  workspaceRows: number;
}) {
  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      height={appHeight}
      paddingX={rootPaddingX}
      overflow="hidden"
    >
      {topChrome}
      <Box
        flexDirection="column"
        width={contentWidth}
        height={workspaceRows}
        overflow="hidden"
        flexShrink={0}
      >
        {chatPanel}
        {taskGapRows > 0 && <Box height={taskGapRows} flexShrink={0} />}
        {tasksDrawer}
        {activityGapRows > 0 && <Box height={activityGapRows} flexShrink={0} />}
        {activityBar}
      </Box>
      {promptInput}
    </Box>
  );
}

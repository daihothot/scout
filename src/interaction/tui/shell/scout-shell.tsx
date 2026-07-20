import React, { type ReactNode } from "react";
import { Box } from "ink";

export function ScoutShell({
  terminalWidth,
  contentWidth,
  appHeight,
  rootPaddingX,
  topChrome,
  chatPanel,
  tasksDrawer,
  activityBar,
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
        {tasksDrawer}
        {activityGapRows > 0 && <Box height={activityGapRows} flexShrink={0} />}
        {activityBar}
      </Box>
      {promptInput}
    </Box>
  );
}

import React, { type ReactNode } from "react";
import { Box } from "ink";

/** Composes top chrome, chat, task drawer, activity, and prompt regions. */
export function ScoutShell({
  terminalWidth,
  contentWidth,
  appHeight,
  rootPaddingX,
  topChromeRows,
  topChrome,
  chatPanel,
  tasksDrawer,
  activityBar,
  taskGapRows,
  activityGapRows,
  promptInput,
  promptRows,
  workspaceRows,
  selectionOverlay,
}: {
  terminalWidth: number;
  contentWidth: number;
  appHeight: number;
  rootPaddingX: number;
  topChromeRows: number;
  topChrome: ReactNode;
  chatPanel: ReactNode;
  tasksDrawer: ReactNode;
  activityBar: ReactNode;
  taskGapRows: number;
  activityGapRows: number;
  promptInput?: ReactNode;
  promptRows: number;
  workspaceRows: number;
  selectionOverlay?: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      height={appHeight}
      paddingX={rootPaddingX}
      overflow="hidden"
    >
      <Box
        width={contentWidth}
        height={topChromeRows}
        overflow="hidden"
        flexShrink={0}
      >
        {topChrome}
      </Box>
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
      {selectionOverlay}
      {promptInput && promptRows > 0 && (
        <Box
          position="absolute"
          bottom={0}
          left={rootPaddingX}
          width={contentWidth}
          height={promptRows}
          overflow="hidden"
          flexShrink={0}
        >
          {promptInput}
        </Box>
      )}
    </Box>
  );
}

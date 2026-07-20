import React from "react";
import { Box, Text } from "ink";
import type { BootSnapshot } from "../../../run/boot/boot-stage.js";
import type {
  TuiRunStatus,
  TuiState,
} from "../tui-store.js";
import { truncateByDisplayWidth } from "../terminal-text.js";

const COMPACT_TOP_CHROME_ROWS = 12;
const FULL_TOP_CHROME_ROWS = 18;
const BOOT_PROGRESS_ROWS = 1;
const BOOT_PROGRESS_MAX_WIDTH = 42;
const FULL_LOGO = [
  "  ____   ____ ___  _   _ _____",
  " / ___| / ___/ _ \\| | | |_   _|",
  " \\___ \\| |  | | | | | | | | |",
  "  ___) | |__| |_| | |_| | | |",
  " |____/ \\____\\___/ \\___/  |_|",
];

export function resolveTopChromeRows(compact: boolean, showBootProgress: boolean): number {
  return (compact ? COMPACT_TOP_CHROME_ROWS : FULL_TOP_CHROME_ROWS)
    + (showBootProgress ? BOOT_PROGRESS_ROWS : 0);
}

export function TopChrome({
  state,
  activeTasks,
  compact,
  width,
}: {
  state: TuiState;
  activeTasks: number;
  compact: boolean;
  width: number;
}) {
  const showBootProgress = Boolean(state.boot && state.runtime.status !== "ready");
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <TopLine state={state} width={width} />

      <Box marginTop={compact ? 0 : 1} flexDirection="column" flexShrink={0}>
        <Text bold>scout</Text>
        {compact
          ? <Text color="cyan" bold>SCOUT</Text>
          : FULL_LOGO.map((line) => <Text key={line} color="cyan">{line}</Text>)}
      </Box>

      <RuntimeCard
        state={state}
        activeTasks={activeTasks}
        compact={compact}
        width={width}
      />

      <RuntimeStatusLine state={state} activeTasks={activeTasks} width={width} />

      {showBootProgress && state.boot && (
        <BootProgress snapshot={state.boot} width={width} />
      )}
    </Box>
  );
}

function TopLine({ state, width }: {
  state: TuiState;
  width: number;
}) {
  const run = state.runtime.runId ?? state.runtime.status;
  const text = `v${state.runtime.version}  ${state.runtime.cwd}  run:${run}`;
  return <Text dimColor>{truncateByDisplayWidth(text, width)}</Text>;
}

function RuntimeCard({
  state,
  activeTasks,
  compact,
  width,
}: {
  state: TuiState;
  activeTasks: number;
  compact: boolean;
  width: number;
}) {
  const contentWidth = Math.max(0, width - 4);
  const runId = state.runtime.runId ?? "pending";
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      width={width}
      flexShrink={0}
    >
      <Text wrap="truncate-end">
        <Text color="cyan" bold>{">_ Scout"}</Text>
        <Text dimColor>{`  v${state.runtime.version}`}</Text>
        <Text>  validation runtime</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>status: </Text>
        <Text color={runtimeStatusColor(state.runtime.status)}>{state.runtime.status}</Text>
        <Text dimColor>{`  run: ${runId}`}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>model: </Text>
        <Text>{state.runtime.model}</Text>
        <Text dimColor>{`  reasoning: ${state.runtime.reasoningEffort}`}</Text>
      </Text>
      {!compact && (
        <Text wrap="truncate-end">
          <Text dimColor>activity: </Text>
          <Text>{`${state.activities.length} items`}</Text>
          <Text dimColor>{`  tasks: ${activeTasks} active / ${state.tasks.length} total`}</Text>
        </Text>
      )}
      <Text wrap="truncate-end">
        <Text dimColor>directory: </Text>
        <Text>{truncateByDisplayWidth(state.runtime.cwd, Math.max(0, contentWidth - 11))}</Text>
      </Text>
    </Box>
  );
}

function RuntimeStatusLine({ state, activeTasks, width }: {
  state: TuiState;
  activeTasks: number;
  width: number;
}) {
  const presentation = runtimeStatusPresentation(state.runtime.status, activeTasks);
  return (
    <Box marginTop={1} width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={presentation.color} bold>{presentation.marker} {presentation.label}</Text>
        <Text dimColor> - {presentation.detail}</Text>
      </Text>
    </Box>
  );
}

function BootProgress({ snapshot, width }: {
  snapshot: BootSnapshot;
  width: number;
}) {
  const presentation = buildBootProgressPresentation(snapshot, width);
  return (
    <Box
      flexDirection="column"
      width={presentation.width}
      height={BOOT_PROGRESS_ROWS}
      flexShrink={0}
      overflow="hidden"
    >
      <Text wrap="truncate-end">
        <Text backgroundColor="yellow">{presentation.filled}</Text>
        <Text backgroundColor="gray">{presentation.remaining}</Text>
      </Text>
    </Box>
  );
}

export function buildBootProgressPresentation(
  snapshot: BootSnapshot,
  width: number,
): {
  width: number;
  filled: string;
  remaining: string;
} {
  const ratio = snapshot.totalStages === 0
    ? 0
    : Math.min(1, Math.max(0, snapshot.completedStages / snapshot.totalStages));
  const barWidth = Math.max(1, Math.min(width, BOOT_PROGRESS_MAX_WIDTH));
  const filledWidth = Math.min(barWidth, Math.round(ratio * barWidth));
  return {
    width: barWidth,
    filled: " ".repeat(filledWidth),
    remaining: " ".repeat(barWidth - filledWidth),
  };
}

function runtimeStatusPresentation(status: TuiRunStatus, activeTasks: number): {
  marker: string;
  label: string;
  detail: string;
  color: "green" | "yellow" | "red" | "gray";
} {
  if (status === "ready") {
    return {
      marker: "*",
      label: "Scout runtime ready",
      detail: activeTasks > 0
        ? `${activeTasks} active task${activeTasks === 1 ? "" : "s"}`
        : "Waiting for input",
      color: "green",
    };
  }
  if (status === "failed") {
    return { marker: "!", label: "Scout runtime failed", detail: "Review system events", color: "red" };
  }
  if (status === "stopping") {
    return { marker: "-", label: "Scout runtime stopping", detail: "Cleaning up", color: "gray" };
  }
  return { marker: "*", label: "Preparing Scout runtime", detail: "Starting agents", color: "yellow" };
}

function runtimeStatusColor(status: TuiRunStatus): "green" | "yellow" | "red" | "gray" {
  if (status === "ready") return "green";
  if (status === "failed") return "red";
  if (status === "preparing") return "yellow";
  return "gray";
}

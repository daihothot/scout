import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { RunLifecycleSnapshot } from "../../../run/lifecycle/run-stage.js";
import { ScoutAgentRoles, type ScoutAgentRole } from "../../../agent/thread/types.js";
import type {
  MountRestoreProgress,
  TuiRunStatus,
  TuiState,
} from "../tui-store.js";
import { tailByDisplayWidth, terminalDisplayWidth } from "../terminal-text.js";
import {
  buildSegmentedProgressTrack,
  buildSubprocessProgressPresentation,
  ProgressTrack,
  SubprocessProgressBar,
  SubprocessProgressStatus,
  subprocessProgressStatusText,
  type SubprocessProgressContent,
  type SubprocessProgressPresentation,
} from "./subprocess-progress-bar.js";

const COMPACT_TOP_CHROME_ROWS = 12;
const FULL_TOP_CHROME_ROWS = 17;
const LIFECYCLE_PROGRESS_ROWS = 1;
const LIFECYCLE_PROGRESS_MAX_WIDTH = 53;
const COMPACT_LIFECYCLE_PROGRESS_MAX_WIDTH = 16;
const MOUNT_STATUS_DETAIL_ROWS = 1;
const MOUNT_STATUS_DETAIL_GAP_ROWS = 1;
const MOUNT_LIFECYCLE_GAP_ROWS = 1;
const MOUNT_RESTORE_FULL_ROWS = 3;
const MOUNT_RESTORE_TOP_GAP_ROWS = 2;
const MOUNT_RESTORE_BOTTOM_GAP_ROWS = 1;
const MOUNT_RESTORE_TRACK_GAP_ROWS = 1;
const MOUNT_RESTORE_BAR_MAX_WIDTH = LIFECYCLE_PROGRESS_MAX_WIDTH;
const MOUNT_RESTORE_INDENT = 2;
const MOUNT_RESTORE_PROCESS_FRAMES = ["›", "▷", "▶", "▷"] as const;
const PREPARING_STATUS_COLOR = "#f2db3f";
const LIFECYCLE_PROGRESS_COLOR = "#e2b40b";
const SUBPROCESS_PROGRESS_COLOR = "#ddd83b";
const RUNTIME_CARD_BORDER_COLOR = "#626262";
const RUNTIME_CARD_COLUMN_GAP = 2;
const RUNTIME_CARD_RUN_TAIL_WIDTH = 8;
const FULL_LOGO = [
  "  ____   ____ ___  _   _ _____",
  " / ___| / ___/ _ \\| | | |_   _|",
  " \\___ \\| |  | | | | | | | | |",
  "  ___) | |__| |_| | |_| | | |",
  " |____/ \\____\\___/ \\___/  |_|",
];

export function resolveTopChromeRows(
  compact: boolean,
  showLifecycleProgress: boolean,
  mountRestore?: MountRestoreProgress,
): number {
  const showMountRestore = mountRestore?.phase === "rebuild";
  const showMountStatusDetail = Boolean(
    mountRestore && mountRestore.phase !== "failed",
  );
  return (compact ? COMPACT_TOP_CHROME_ROWS : FULL_TOP_CHROME_ROWS)
    + (showLifecycleProgress ? LIFECYCLE_PROGRESS_ROWS : 0)
    + (!compact && showMountStatusDetail
      ? MOUNT_STATUS_DETAIL_GAP_ROWS
        + MOUNT_STATUS_DETAIL_ROWS
        + (showLifecycleProgress ? MOUNT_LIFECYCLE_GAP_ROWS : 0)
      : 0)
    + (showMountRestore
      ? compact
        ? MOUNT_RESTORE_BOTTOM_GAP_ROWS
        : MOUNT_RESTORE_TOP_GAP_ROWS
          + MOUNT_RESTORE_FULL_ROWS
          + MOUNT_RESTORE_BOTTOM_GAP_ROWS
      : 0);
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
  const showLifecycleProgress = Boolean(
    state.lifecycle && state.runtime.status !== "ready",
  );
  const showMountStatusDetail = Boolean(
    !compact
      && state.runtime.status === "preparing"
      && state.mountRestore
      && state.mountRestore.phase !== "failed",
  );
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
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

      <RuntimeStatusLine
        state={state}
        activeTasks={activeTasks}
        compact={compact}
        width={width}
      />

      {showLifecycleProgress && showMountStatusDetail && (
        <Box height={MOUNT_LIFECYCLE_GAP_ROWS} flexShrink={0} />
      )}

      {showLifecycleProgress && state.lifecycle && (
        <RunLifecycleProgress
          snapshot={state.lifecycle}
          width={width}
          compact={compact}
          compactMountRestore={compact && state.mountRestore?.phase === "rebuild"
            ? state.mountRestore
            : undefined}
        />
      )}

      {/* Failure stays in the status line and SYSTEM disclosure; the strip is rebuild-only. */}
      {!compact
        && state.runtime.status !== "ready"
        && state.mountRestore?.phase === "rebuild" && (
        <MountRestoreStrip
          progress={state.mountRestore}
          width={width}
        />
      )}
      {compact
        && state.runtime.status !== "ready"
        && state.mountRestore?.phase === "rebuild" && (
        <Box height={MOUNT_RESTORE_BOTTOM_GAP_ROWS} flexShrink={0} />
      )}
    </Box>
  );
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
  const statusColor = state.runtime.status === "preparing"
    ? LIFECYCLE_PROGRESS_COLOR
    : runtimeStatusColor(state.runtime.status);
  const statusTextWidth = terminalDisplayWidth(`status: ${state.runtime.status}`);
  const modelTextWidth = terminalDisplayWidth(`model: ${state.runtime.model}`);
  const reasoningTextWidth = terminalDisplayWidth(
    `reasoning: ${state.runtime.reasoningEffort}`,
  );
  const activityTextWidth = terminalDisplayWidth(
    `activity: ${state.activities.length} items`,
  );
  const tasksTextWidth = terminalDisplayWidth(`tasks: ${activeTasks}`);
  const runLabelWidth = terminalDisplayWidth("run: ");
  const fullStatusWidth = statusTextWidth + RUNTIME_CARD_COLUMN_GAP;
  const fullModelWidth = modelTextWidth + RUNTIME_CARD_COLUMN_GAP;
  const fullReasoningWidth = reasoningTextWidth;
  const fullRunFieldWidth = Math.max(
    runLabelWidth + RUNTIME_CARD_COLUMN_GAP,
    Math.min(
      runLabelWidth + RUNTIME_CARD_RUN_TAIL_WIDTH + RUNTIME_CARD_COLUMN_GAP,
      contentWidth - fullStatusWidth - fullModelWidth - fullReasoningWidth,
    ),
  );
  const fullRunValue = tailByDisplayWidth(
    runId,
    Math.max(
      0,
      fullRunFieldWidth - runLabelWidth - RUNTIME_CARD_COLUMN_GAP,
    ),
  );
  const activityColumnWidth = activityTextWidth + RUNTIME_CARD_COLUMN_GAP;
  const tasksColumnWidth = tasksTextWidth + RUNTIME_CARD_COLUMN_GAP;
  const directoryColumnWidth = Math.max(
    1,
    contentWidth - activityColumnWidth - tasksColumnWidth,
  );
  const compactStatusWidth = Math.min(
    contentWidth,
    statusTextWidth + RUNTIME_CARD_COLUMN_GAP,
  );
  const compactModelWidth = Math.min(
    contentWidth,
    modelTextWidth + RUNTIME_CARD_COLUMN_GAP,
  );
  const compactActivityWidth = Math.min(
    contentWidth,
    activityTextWidth + RUNTIME_CARD_COLUMN_GAP,
  );
  const compactRunWidth = Math.max(0, contentWidth - compactStatusWidth);
  const compactRunValue = tailByDisplayWidth(
    runId,
    Math.max(0, Math.min(
      RUNTIME_CARD_RUN_TAIL_WIDTH,
      compactRunWidth - runLabelWidth,
    )),
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={RUNTIME_CARD_BORDER_COLOR}
      borderDimColor
      paddingX={1}
      marginTop={1}
      width={width}
      flexShrink={0}
    >
      <Text wrap="truncate-end">
        <Text bold>{">_ Scout"}</Text>
        <Text>{` v${state.runtime.version} validation runtime`}</Text>
      </Text>
      {!compact && <Box height={1} flexShrink={0} />}
      {compact ? (
        <>
          <Box flexDirection="row" width={contentWidth}>
            <RuntimeCardField
              label="status"
              value={state.runtime.status}
              valueColor={statusColor}
              width={compactStatusWidth}
              gap={RUNTIME_CARD_COLUMN_GAP}
            />
            <RuntimeCardField
              label="run"
              value={compactRunValue}
              width={compactRunWidth}
            />
          </Box>
          <Box flexDirection="row" width={contentWidth}>
            <RuntimeCardField
              label="model"
              value={state.runtime.model}
              valueColor="cyan"
              width={compactModelWidth}
              gap={RUNTIME_CARD_COLUMN_GAP}
            />
            <RuntimeCardField
              label="reasoning"
              value={state.runtime.reasoningEffort}
              valueColor="cyan"
              width={Math.max(0, contentWidth - compactModelWidth)}
            />
          </Box>
          <Box flexDirection="row" width={contentWidth}>
            <RuntimeCardField
              label="activity"
              value={`${state.activities.length}`}
              valueColor="cyan"
              suffix=" items"
              width={compactActivityWidth}
              gap={RUNTIME_CARD_COLUMN_GAP}
            />
            <RuntimeCardField
              label="tasks"
              value={`${activeTasks}`}
              valueColor="cyan"
              width={Math.max(0, contentWidth - compactActivityWidth)}
            />
          </Box>
          <RuntimeCardField label="dir" value={state.runtime.cwd} width={contentWidth} />
        </>
      ) : (
        <>
          <Box flexDirection="row" width={contentWidth}>
            <RuntimeCardField
              label="status"
              value={state.runtime.status}
              valueColor={statusColor}
              width={fullStatusWidth}
              gap={RUNTIME_CARD_COLUMN_GAP}
            />
            <RuntimeCardField
              label="run"
              value={fullRunValue}
              width={fullRunFieldWidth}
              gap={RUNTIME_CARD_COLUMN_GAP}
            />
            <RuntimeCardField
              label="model"
              value={state.runtime.model}
              valueColor="cyan"
              width={fullModelWidth}
              gap={RUNTIME_CARD_COLUMN_GAP}
            />
            <RuntimeCardField
              label="reasoning"
              value={state.runtime.reasoningEffort}
              valueColor="cyan"
              width={fullReasoningWidth}
            />
          </Box>
          <Box height={1} flexShrink={0} />
          <Box flexDirection="row" width={contentWidth}>
            <RuntimeCardField
              label="activity"
              value={`${state.activities.length}`}
              valueColor="cyan"
              suffix=" items"
              width={activityColumnWidth}
              gap={RUNTIME_CARD_COLUMN_GAP}
            />
            <RuntimeCardField
              label="tasks"
              value={`${activeTasks}`}
              valueColor="cyan"
              width={tasksColumnWidth}
              gap={RUNTIME_CARD_COLUMN_GAP}
            />
            <RuntimeCardField
              label="dir"
              value={state.runtime.cwd}
              width={directoryColumnWidth}
            />
          </Box>
        </>
      )}
    </Box>
  );
}

function RuntimeCardField({ label, value, valueColor, suffix, width, gap = 0 }: {
  label: string;
  value: string;
  valueColor?: string;
  suffix?: string;
  width: number;
  gap?: number;
}) {
  return (
    <Box width={width} paddingRight={gap} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end">
        <Text dimColor>{`${label}: `}</Text>
        <Text color={valueColor}>{value}</Text>
        {suffix && <Text dimColor>{suffix}</Text>}
      </Text>
    </Box>
  );
}

function RuntimeStatusLine({ state, activeTasks, compact, width }: {
  state: TuiState;
  activeTasks: number;
  compact: boolean;
  width: number;
}) {
  const showMountStatus = state.runtime.status === "preparing"
    || (state.runtime.status === "failed" && state.mountRestore?.phase === "failed");
  const mountRestore = showMountStatus ? state.mountRestore : undefined;
  const presentation = mountRestore
    ? buildMountRestoreStatusPresentation(mountRestore)
    : runtimeStatusPresentation(state.runtime.status, activeTasks);
  const splitMountDetail = Boolean(
    mountRestore && mountRestore.phase !== "failed",
  );
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      width={width}
      flexShrink={0}
    >
      <Text wrap="truncate-end">
        <Text
          color={presentation.color === "yellow"
            ? PREPARING_STATUS_COLOR
            : presentation.color}
          bold
        >
          {presentation.marker} {presentation.label}
        </Text>
        {splitMountDetail
          ? compact && mountRestore && (
            <MountRestoreStatusDetail progress={mountRestore} compact />
          )
          : <Text dimColor>{` - ${presentation.detail}`}</Text>}
      </Text>
      {splitMountDetail && !compact && mountRestore && (
        <>
          <Box height={MOUNT_STATUS_DETAIL_GAP_ROWS} flexShrink={0} />
          <MountRestoreStatusDetail progress={mountRestore} />
        </>
      )}
    </Box>
  );
}

function MountRestoreStrip({ progress, width }: {
  progress: MountRestoreProgress;
  width: number;
}) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (process.env.SCOUT_TUI_MOTION === "0") return;
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % MOUNT_RESTORE_PROCESS_FRAMES.length);
    }, 90);
    return () => clearInterval(timer);
  }, []);

  const trackWidth = Math.max(1, width - MOUNT_RESTORE_INDENT);
  const presentation = buildMountRestoreProgressPresentation(progress, trackWidth, frame);
  return (
    <Box
      flexDirection="column"
      width={width}
      height={MOUNT_RESTORE_FULL_ROWS}
      marginTop={MOUNT_RESTORE_TOP_GAP_ROWS}
      marginBottom={MOUNT_RESTORE_BOTTOM_GAP_ROWS}
      flexShrink={0}
      overflow="hidden"
    >
      <SubprocessProgressBar
        presentation={presentation}
        markerColor={PREPARING_STATUS_COLOR}
        trackColor={SUBPROCESS_PROGRESS_COLOR}
        trackIndent={MOUNT_RESTORE_INDENT}
        trackGapRows={MOUNT_RESTORE_TRACK_GAP_ROWS}
      />
    </Box>
  );
}

export function buildMountRestoreProgressPresentation(
  progress: MountRestoreProgress,
  width: number,
  frame = 0,
): SubprocessProgressPresentation {
  return buildSubprocessProgressPresentation({
    completedUnits: progress.completedUnits,
    totalUnits: progress.totalUnits,
    content: buildMountSubprocessContent(
      progress,
      MOUNT_RESTORE_PROCESS_FRAMES[frame % MOUNT_RESTORE_PROCESS_FRAMES.length],
    ),
    width,
    maxBarWidth: MOUNT_RESTORE_BAR_MAX_WIDTH,
  });
}

function buildMountSubprocessContent(
  progress: MountRestoreProgress,
  marker: string,
): SubprocessProgressContent {
  return {
    marker,
    label: roleLabel(progress.activeRole),
    detail: progress.activeStep && progress.activeStep !== "verify"
      ? progress.activeStep
      : undefined,
    units: `${progress.completedUnits}/${progress.totalUnits}`,
  };
}

function mountVerifyDetail(progress: MountRestoreProgress): string {
  const planned = progress.roles.filter((role) => role.decision !== "pending").length;
  return planned === progress.roles.length && progress.roles.length > 0
    ? `Mount · verifying · ${reusableRoleCount(progress)}/${progress.roles.length} reusable`
    : "Mount · verifying";
}

function MountRestoreStatusDetail({ progress, compact = false }: {
  progress: MountRestoreProgress;
  compact?: boolean;
}) {
  const step = progress.phase === "rebuild"
    ? progress.activeStep ?? "rebuilding"
    : progress.phase === "verify"
      ? "verifying"
      : "ready";
  const suffix = progress.phase === "rebuild"
    ? progress.activeRole
      ? roleLabel(progress.activeRole)
      : undefined
    : progress.phase === "verify"
      && progress.roles.every((role) => role.decision !== "pending")
      && progress.roles.length > 0
        ? `${reusableRoleCount(progress)}/${progress.roles.length} reusable`
        : progress.phase === "done"
          && progress.roles.every((role) => role.decision === "reused")
          ? `${reusableRoleCount(progress)}/${progress.roles.length} reusable`
          : undefined;
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{compact ? " · Mount " : "  Mount · "}</Text>
      <Text color="white">{step}</Text>
      {!compact && suffix && <Text dimColor>{` · ${suffix}`}</Text>}
    </Text>
  );
}

export function buildMountRestoreStatusPresentation(progress: MountRestoreProgress): {
  marker: string;
  label: string;
  detail: string;
  color: "green" | "yellow" | "red" | "gray";
} {
  if (progress.phase === "failed") {
    return {
      marker: "!",
      label: "Mount restore failed",
      detail: `${roleLabel(progress.activeRole)}${progress.activeStep ? ` ${progress.activeStep}` : ""}`,
      color: "red",
    };
  }
  if (progress.phase === "rebuild") {
    const role = progress.activeRole ? roleLabel(progress.activeRole) : undefined;
    return {
      marker: "*",
      label: "Preparing Scout runtime",
      detail: `Mount · ${progress.activeStep ?? "rebuilding"}${role ? ` · ${role}` : ""}`,
      color: "yellow",
    };
  }
  if (progress.phase === "verify") {
    return {
      marker: "*",
      label: "Preparing Scout runtime",
      detail: mountVerifyDetail(progress),
      color: "yellow",
    };
  }
  if (progress.phase === "done") {
    return {
      marker: "*",
      label: "Preparing Scout runtime",
      detail: progress.roles.every((role) => role.decision === "reused")
        ? `Mount · ready · ${reusableRoleCount(progress)}/${progress.roles.length} reusable`
        : "Mount · ready",
      color: "yellow",
    };
  }
  return runtimeStatusPresentation("preparing", 0);
}

function reusableRoleCount(progress: MountRestoreProgress): number {
  return progress.roles.filter((role) => role.decision === "reused").length;
}

function roleLabel(role: ScoutAgentRole | undefined): string {
  if (role === ScoutAgentRoles.Coordinator) return "coordinator";
  if (role === ScoutAgentRoles.Researcher) return "researcher";
  if (role === ScoutAgentRoles.Verifier) return "verifier";
  if (role === ScoutAgentRoles.Validator) return "validator";
  return "mount";
}

function RunLifecycleProgress({ snapshot, width, compact, compactMountRestore }: {
  snapshot: RunLifecycleSnapshot;
  width: number;
  compact: boolean;
  compactMountRestore?: MountRestoreProgress;
}) {
  const subprocessContent = compactMountRestore
    ? buildMountSubprocessContent(compactMountRestore, "▷")
    : undefined;
  const trailingText = subprocessContent
    ? subprocessProgressStatusText(subprocessContent, true)
    : undefined;
  const trackIndent = compact ? 0 : MOUNT_RESTORE_INDENT;
  const presentation = buildRunLifecycleProgressPresentation(
    snapshot,
    Math.max(1, width - trackIndent),
    trailingText,
  );
  return (
    <Box
      flexDirection="row"
      width={width}
      height={LIFECYCLE_PROGRESS_ROWS}
      flexShrink={0}
      overflow="hidden"
    >
      {trackIndent > 0 && <Text>{" ".repeat(trackIndent)}</Text>}
      <Text wrap="truncate-end">
        <ProgressTrack
          filled={presentation.filled}
          remaining={presentation.remaining}
          color={LIFECYCLE_PROGRESS_COLOR}
        />
      </Text>
      {subprocessContent && (
        <>
          <Text>{"  "}</Text>
          <SubprocessProgressStatus
            content={subprocessContent}
            markerColor={PREPARING_STATUS_COLOR}
            compact
          />
        </>
      )}
    </Box>
  );
}

export function buildRunLifecycleProgressPresentation(
  snapshot: RunLifecycleSnapshot,
  width: number,
  trailingText?: string,
): {
  width: number;
  filled: string;
  remaining: string;
} {
  const trailingWidth = trailingText
    ? terminalDisplayWidth(trailingText) + 2
    : 0;
  const maxBarWidth = trailingText
    ? COMPACT_LIFECYCLE_PROGRESS_MAX_WIDTH
    : LIFECYCLE_PROGRESS_MAX_WIDTH;
  return buildSegmentedProgressTrack({
    completedUnits: snapshot.completedStages,
    totalUnits: snapshot.totalStages,
    width: Math.max(1, width - trailingWidth),
    maxWidth: maxBarWidth,
    filledCell: "█",
    remainingCell: "█",
    cellWidth: 2,
    separator: "▉",
  });
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

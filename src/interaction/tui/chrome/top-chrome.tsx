import React from "react";
import { Box, Text } from "ink";
import type { RunLifecycleSnapshot } from "../../../run/lifecycle/run-stage.js";
import type {
  SubprocessProgressSnapshot,
  SubprocessProgressText,
  SubprocessProgressTone,
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
  type ProgressTrackColor,
} from "./subprocess-progress-bar.js";

const COMPACT_TOP_CHROME_ROWS = 12;
const FULL_TOP_CHROME_ROWS = 17;
const LIFECYCLE_PROGRESS_ROWS = 1;
const LIFECYCLE_PROGRESS_MAX_WIDTH = 53;
const COMPACT_LIFECYCLE_PROGRESS_MAX_WIDTH = 16;
const SUBPROCESS_STATUS_DETAIL_ROWS = 1;
const SUBPROCESS_STATUS_DETAIL_GAP_ROWS = 1;
const SUBPROCESS_LIFECYCLE_GAP_ROWS = 1;
const SUBPROCESS_FULL_ROWS = 3;
const SUBPROCESS_TOP_GAP_ROWS = 2;
const SUBPROCESS_BOTTOM_GAP_ROWS = 1;
const SUBPROCESS_TRACK_GAP_ROWS = 1;
const SUBPROCESS_BAR_MAX_WIDTH = LIFECYCLE_PROGRESS_MAX_WIDTH;
const SUBPROCESS_INDENT = 2;
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

/** Computes the fixed top-chrome row budget, including active lifecycle/subprocess strips. */
export function resolveTopChromeRows(
  compact: boolean,
  showLifecycleProgress: boolean,
  subprocessProgress?: SubprocessProgressSnapshot,
): number {
  const showSubprocessTrack = Boolean(
    subprocessProgress?.phase === "running"
      && subprocessProgress.descriptor.progress,
  );
  const showSubprocessStatusDetail = Boolean(
    subprocessProgress
      && subprocessProgress.phase !== "failed"
      && subprocessProgress.descriptor.status.detail,
  );
  return (compact ? COMPACT_TOP_CHROME_ROWS : FULL_TOP_CHROME_ROWS)
    + (showLifecycleProgress ? LIFECYCLE_PROGRESS_ROWS : 0)
    + (!compact && showSubprocessStatusDetail
      ? SUBPROCESS_STATUS_DETAIL_GAP_ROWS
        + SUBPROCESS_STATUS_DETAIL_ROWS
        + (showLifecycleProgress ? SUBPROCESS_LIFECYCLE_GAP_ROWS : 0)
      : 0)
    + (showSubprocessTrack
      ? compact
        ? SUBPROCESS_BOTTOM_GAP_ROWS
        : SUBPROCESS_TOP_GAP_ROWS
          + SUBPROCESS_FULL_ROWS
          + SUBPROCESS_BOTTOM_GAP_ROWS
      : 0);
}

/** Renders Scout identity, runtime facts, lifecycle progress, and active subprocess progress. */
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
  const showSubprocessStatusDetail = Boolean(
    !compact
      && state.runtime.status === "preparing"
      && state.subprocessProgress
      && state.subprocessProgress.phase !== "failed"
      && state.subprocessProgress.descriptor.status.detail,
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

      {showLifecycleProgress && showSubprocessStatusDetail && (
        <Box height={SUBPROCESS_LIFECYCLE_GAP_ROWS} flexShrink={0} />
      )}

      {showLifecycleProgress && state.lifecycle && (
        <RunLifecycleProgress
          snapshot={state.lifecycle}
          width={width}
          compact={compact}
          compactSubprocessProgress={compact && state.subprocessProgress?.phase === "running"
            ? state.subprocessProgress
            : undefined}
        />
      )}

      {/* Failure stays in the status line and SYSTEM disclosure; the track is active-only. */}
      {!compact
        && state.runtime.status !== "ready"
        && state.subprocessProgress?.phase === "running"
        && state.subprocessProgress.descriptor.progress && (
        <SubprocessProgressStrip
          progress={state.subprocessProgress}
          width={width}
        />
      )}
      {compact
        && state.runtime.status !== "ready"
        && state.subprocessProgress?.phase === "running"
        && state.subprocessProgress.descriptor.progress && (
        <Box height={SUBPROCESS_BOTTOM_GAP_ROWS} flexShrink={0} />
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
  const subprocess = state.subprocessProgress;
  const useSubprocessStatus = Boolean(
    subprocess
      && (state.runtime.status === "preparing"
        || (state.runtime.status === "failed" && subprocess.phase === "failed")),
  );
  const presentation = useSubprocessStatus
    ? buildSubprocessStatusPresentation(subprocess!.descriptor.status)
    : runtimeStatusPresentation(state.runtime.status, activeTasks);
  const splitSubprocessDetail = Boolean(
    useSubprocessStatus
      && subprocess
      && subprocess.phase !== "failed"
      && subprocess.descriptor.status.detail,
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
        {splitSubprocessDetail
          ? compact && subprocess && (
            <SubprocessStatusDetail
              descriptor={subprocess.descriptor.status}
              compact
            />
          )
          : <Text dimColor>{` - ${presentation.detail}`}</Text>}
      </Text>
      {splitSubprocessDetail && !compact && subprocess && (
        <>
          <Box height={SUBPROCESS_STATUS_DETAIL_GAP_ROWS} flexShrink={0} />
          <SubprocessStatusDetail descriptor={subprocess.descriptor.status} />
        </>
      )}
    </Box>
  );
}

function SubprocessProgressStrip({ progress, width }: {
  progress: SubprocessProgressSnapshot;
  width: number;
}) {
  const content = progress.descriptor.progress;
  if (!content) return null;
  const trackWidth = Math.max(1, width - SUBPROCESS_INDENT);
  const presentation = buildSubprocessProgressPresentation({
    completedUnits: progress.completedUnits,
    totalUnits: progress.totalUnits,
    content,
    width: trackWidth,
    maxBarWidth: SUBPROCESS_BAR_MAX_WIDTH,
  });
  return (
    <Box
      flexDirection="column"
      width={width}
      height={SUBPROCESS_FULL_ROWS}
      marginTop={SUBPROCESS_TOP_GAP_ROWS}
      marginBottom={SUBPROCESS_BOTTOM_GAP_ROWS}
      flexShrink={0}
      overflow="hidden"
    >
      <SubprocessProgressBar
        presentation={presentation}
        markerColor={subprocessToneColor(content.tone)}
        trackColor={subprocessToneColor(content.tone, SUBPROCESS_PROGRESS_COLOR)}
        trackIndent={SUBPROCESS_INDENT}
        trackGapRows={SUBPROCESS_TRACK_GAP_ROWS}
      />
    </Box>
  );
}

function SubprocessStatusDetail({ descriptor, compact = false }: {
  descriptor: SubprocessProgressText;
  compact?: boolean;
}) {
  const detail = descriptor.detail ?? "";
  return (
    <Text wrap="truncate-end">
      {detail && <Text color="white">{compact ? ` · ${detail}` : `  ${detail}`}</Text>}
      {descriptor.units && <Text dimColor>{` · ${descriptor.units}`}</Text>}
    </Text>
  );
}

/** Converts operation-owned status text into the marker/label/detail presentation used by chrome. */
export function buildSubprocessStatusPresentation(descriptor: SubprocessProgressText): {
  marker: string;
  label: string;
  detail: string;
  color: ProgressTrackColor;
} {
  return {
    marker: descriptor.marker ?? "*",
    label: descriptor.label,
    detail: descriptor.detail ?? "",
    color: subprocessToneColor(descriptor.tone, "yellow"),
  };
}

function subprocessToneColor(
  tone: SubprocessProgressTone | undefined,
  activeFallback: ProgressTrackColor = PREPARING_STATUS_COLOR,
): ProgressTrackColor {
  if (tone === "failed") return "red";
  if (tone === "success") return "green";
  if (tone === "neutral") return "gray";
  return activeFallback;
}

function RunLifecycleProgress({ snapshot, width, compact, compactSubprocessProgress }: {
  snapshot: RunLifecycleSnapshot;
  width: number;
  compact: boolean;
  compactSubprocessProgress?: SubprocessProgressSnapshot;
}) {
  const subprocessContent = compactSubprocessProgress?.descriptor.progress;
  const trailingText = subprocessContent
    ? subprocessProgressStatusText(subprocessContent, true)
    : undefined;
  const trackIndent = compact ? 0 : SUBPROCESS_INDENT;
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
      {subprocessContent && compactSubprocessProgress && (
        <>
          <Text>{"  "}</Text>
          <SubprocessProgressStatus
            content={subprocessContent}
            markerColor={subprocessToneColor(subprocessContent.tone)}
            compact
          />
        </>
      )}
    </Box>
  );
}

/** Converts run lifecycle units into a segmented track and optional compact subprocess suffix. */
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

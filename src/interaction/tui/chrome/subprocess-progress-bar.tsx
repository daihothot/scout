import React from "react";
import { Box, Text } from "ink";
import { terminalDisplayWidth } from "../terminal-text.js";

const DEFAULT_MAX_BAR_WIDTH = 42;
const FILLED_TRACK = "▪";
const REMAINING_TRACK = "▫";
const TRACK_SEPARATOR = "";

type ProgressTrackColor = "yellow" | "red" | "gray" | "white" | `#${string}`;

export interface SubprocessProgressContent {
  marker?: string;
  label: string;
  detail?: string;
  units: string;
}

export interface SubprocessProgressPresentation {
  width: number;
  filled: string;
  remaining: string;
  content: SubprocessProgressContent;
}

export interface SegmentedProgressTrack {
  width: number;
  filled: string;
  remaining: string;
}

export function buildSegmentedProgressTrack(input: {
  completedUnits: number;
  totalUnits: number;
  width: number;
  maxWidth: number;
  filledCell: string;
  remainingCell: string;
  cellWidth: number;
  separator?: string;
}): SegmentedProgressTrack {
  const ratio = input.totalUnits === 0
    ? 0
    : Math.min(1, Math.max(0, input.completedUnits / input.totalUnits));
  const availableWidth = Math.max(1, Math.min(input.maxWidth, input.width));
  const separator = input.separator ?? TRACK_SEPARATOR;
  const separatorWidth = terminalDisplayWidth(separator);
  const cellWidth = Math.max(1, Math.min(input.cellWidth, availableWidth));
  const cellCount = Math.max(
    1,
    Math.floor((availableWidth + separatorWidth) / (cellWidth + separatorWidth)),
  );
  const filledCount = Math.min(cellCount, Math.round(ratio * cellCount));
  const remainingCount = cellCount - filledCount;
  const filledCell = input.filledCell.repeat(cellWidth);
  const remainingCell = input.remainingCell.repeat(cellWidth);
  const filled = Array.from({ length: filledCount }, () => filledCell).join(separator)
    + (filledCount > 0 && remainingCount > 0 ? separator : "");
  const remaining = Array.from({ length: remainingCount }, () => remainingCell).join(separator);
  return {
    width: (cellCount * cellWidth) + ((cellCount - 1) * separatorWidth),
    filled,
    remaining,
  };
}

export function buildSubprocessProgressPresentation(input: {
  completedUnits: number;
  totalUnits: number;
  content: SubprocessProgressContent;
  width: number;
  maxBarWidth?: number;
}): SubprocessProgressPresentation {
  const track = buildSegmentedProgressTrack({
    completedUnits: input.completedUnits,
    totalUnits: input.totalUnits,
    width: input.width,
    maxWidth: Math.max(1, input.maxBarWidth ?? DEFAULT_MAX_BAR_WIDTH),
    filledCell: FILLED_TRACK,
    remainingCell: REMAINING_TRACK,
    cellWidth: 1,
  });
  return {
    ...track,
    content: { ...input.content },
  };
}

export function SubprocessProgressBar({
  presentation,
  markerColor = "yellow",
  trackColor = "yellow",
  trackIndent = 0,
  trackGapRows = 0,
}: {
  presentation: SubprocessProgressPresentation;
  markerColor?: ProgressTrackColor;
  trackColor?: ProgressTrackColor;
  trackIndent?: number;
  trackGapRows?: number;
}) {
  return (
    <>
      <SubprocessProgressStatus
        content={presentation.content}
        markerColor={markerColor}
      />
      {trackGapRows > 0 && <Box height={trackGapRows} flexShrink={0} />}
      <Box marginLeft={trackIndent} flexShrink={0}>
        <Text wrap="truncate-end">
          <ProgressTrack
            filled={presentation.filled}
            remaining={presentation.remaining}
            color={trackColor}
          />
        </Text>
      </Box>
    </>
  );
}

export function SubprocessProgressStatus({
  content,
  markerColor = "yellow",
  compact = false,
}: {
  content: SubprocessProgressContent;
  markerColor?: ProgressTrackColor;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Text wrap="truncate-end">
        <Text>{content.label}</Text>
        {content.marker && <Text color={markerColor}>{content.marker}</Text>}
        {content.detail && <Text dimColor>{content.detail}</Text>}
        <Text dimColor>{` ${content.units}`}</Text>
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      {content.marker && <Text color={markerColor}>{`${content.marker} `}</Text>}
      <Text>{content.label}</Text>
      {content.detail && <Text dimColor>{`  ${content.detail}`}</Text>}
      <Text dimColor>{`  ${content.units}`}</Text>
    </Text>
  );
}

export function subprocessProgressStatusText(
  content: SubprocessProgressContent,
  compact = false,
): string {
  if (compact) {
    return `${content.label}${content.marker ?? ""}${content.detail ?? ""} ${content.units}`;
  }
  return `${content.marker ? `${content.marker} ` : ""}${content.label}${content.detail ? `  ${content.detail}` : ""}  ${content.units}`;
}

export function ProgressTrack({
  filled,
  remaining,
  color,
  background = false,
}: {
  filled: string;
  remaining: string;
  color: ProgressTrackColor;
  background?: boolean;
}) {
  if (!background) {
    return (
      <>
        <Text color={color}>{filled}</Text>
        <Text color="gray" dimColor>{remaining}</Text>
      </>
    );
  }
  return (
    <>
      <Text backgroundColor={color}>{filled}</Text>
      <Text backgroundColor="gray">{remaining}</Text>
    </>
  );
}

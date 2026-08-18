import ansiEscapes from "ansi-escapes";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useStdout } from "ink";
import type { TuiAgentActivityStripItem } from "../selectors/activity-strip.js";
import {
  buildTerminalMarkdownLines,
  type TerminalMarkdownSpan,
} from "../terminal-markdown.js";
import { roleColor, statusColor } from "../theme.js";
import { terminalDisplayWidth, wrapByDisplayWidth } from "../terminal-text.js";

const BREATHING_FRAMES = ["·", "◌", "○", "◉", "○", "◌"] as const;
const PROCESS_FRAMES = ["›", "▷", "▶", "▷"] as const;
const FOLD_FRAMES = ["▬", "▭", "▪", "·", "▪", "▭"] as const;
const BREATHING_FRAME_MS = 120;
const PROCESS_FRAME_MS = 90;
const FOLD_FRAME_MS = 110;
const BREATHING_CYCLE_MS = BREATHING_FRAMES.length * BREATHING_FRAME_MS;
const FOLD_CYCLE_MS = FOLD_FRAMES.length * FOLD_FRAME_MS;
const MIN_ANIMATED_WIDTH = 16;
const TOOL_ACTIVITY_TYPES = new Set([
  "commandExecution",
  "mcpToolCall",
  "fileChange",
]);

type ActivityAnimation = "breathing" | "process" | "fold";

/** Render-ready markdown lines plus the fixed prefix width used by the activity strip. */
export interface ActivityBarPresentation {
  lines: TerminalMarkdownSpan[][];
  prefixWidth: number;
  taskRef: string;
}

/** Renders the current agent activity with optional lifecycle animation and width-safe wrapping. */
export function ActivityBar({ item, width, height, screenX, screenY, onVisibleLinesChange }: {
  item?: TuiAgentActivityStripItem;
  width: number;
  height: number;
  screenX: number;
  screenY: number;
  onVisibleLinesChange?: (lines: string[]) => void;
}) {
  const motionEnabled = process.env.SCOUT_TUI_MOTION !== "0"
    && width >= MIN_ANIMATED_WIDTH;
  const requestedAnimation = activityAnimation(item, motionEnabled);
  const [animation, setAnimation] = useState<ActivityAnimation | undefined>(() =>
    initialActivityAnimation(item, requestedAnimation, motionEnabled)
  );
  const frameRef = useRef(0);
  const renderedAnimationRef = useRef(animation);
  const { stdout } = useStdout();
  if (renderedAnimationRef.current !== animation) {
    renderedAnimationRef.current = animation;
    frameRef.current = 0;
  }
  const activityId = item?.activityId;
  const activityIdRef = useRef(activityId);
  const animationRef = useRef(animation);
  const minimumCycleRef = useRef<{
    animation: "breathing" | "fold";
    startedAt: number;
  } | undefined>(
    animation === "breathing" || animation === "fold"
      ? { animation, startedAt: Date.now() }
      : undefined,
  );

  useEffect(() => {
    let transitionTimer: ReturnType<typeof setTimeout> | undefined;
    const transition = (next: ActivityAnimation | undefined) => {
      animationRef.current = next;
      setAnimation(next);
    };
    const startMinimumCycle = (
      cycle: "breathing" | "fold",
      next: ActivityAnimation | undefined,
    ) => {
      minimumCycleRef.current = { animation: cycle, startedAt: Date.now() };
      frameRef.current = 0;
      transition(cycle);
      if (next !== cycle) {
        transitionTimer = setTimeout(() => {
          minimumCycleRef.current = undefined;
          transition(next);
        }, cycle === "breathing" ? BREATHING_CYCLE_MS : FOLD_CYCLE_MS);
      }
    };
    const finishMinimumCycle = (next: ActivityAnimation | undefined) => {
      const cycle = minimumCycleRef.current;
      if (!cycle || animationRef.current !== cycle.animation) {
        minimumCycleRef.current = undefined;
        transition(next);
        return;
      }
      const completeCycle = () => {
        minimumCycleRef.current = undefined;
        if (cycle.animation === "fold" && next === "breathing") {
          startMinimumCycle("breathing", "breathing");
        } else {
          transition(next);
        }
      };
      const cycleMs = cycle.animation === "breathing" ? BREATHING_CYCLE_MS : FOLD_CYCLE_MS;
      const remaining = Math.max(0, cycleMs - (Date.now() - cycle.startedAt));
      if (remaining > 0) {
        transitionTimer = setTimeout(completeCycle, remaining);
      } else {
        completeCycle();
      }
    };

    if (!motionEnabled) {
      minimumCycleRef.current = undefined;
      transition(undefined);
      return () => clearTimeout(transitionTimer);
    }

    if (activityIdRef.current !== activityId) {
      activityIdRef.current = activityId;
      if (
        requestedAnimation === "fold"
        || (item?.type === "contextCompaction" && item.status === "completed")
      ) {
        startMinimumCycle("fold", requestedAnimation);
      } else if (animationRef.current === "fold") {
        finishMinimumCycle(requestedAnimation);
      } else if (shouldCompleteBreathingCycle(item, requestedAnimation)) {
        startMinimumCycle("breathing", requestedAnimation);
      } else {
        minimumCycleRef.current = undefined;
        transition(requestedAnimation);
      }
      return () => clearTimeout(transitionTimer);
    }

    if (requestedAnimation === "fold") {
      if (animationRef.current !== "fold") {
        startMinimumCycle("fold", "fold");
      }
      return () => clearTimeout(transitionTimer);
    }

    if (animationRef.current === "fold") {
      finishMinimumCycle(requestedAnimation);
      return () => clearTimeout(transitionTimer);
    }

    if (requestedAnimation === "breathing") {
      if (animationRef.current !== "breathing") {
        startMinimumCycle("breathing", "breathing");
      }
      return () => clearTimeout(transitionTimer);
    }

    if (animationRef.current === "breathing") {
      finishMinimumCycle(requestedAnimation);
    } else {
      minimumCycleRef.current = undefined;
      transition(requestedAnimation);
    }
    return () => clearTimeout(transitionTimer);
  }, [activityId, item?.status, item?.type, motionEnabled, requestedAnimation]);

  const presentation = useMemo(
    () => buildActivityBarPresentation(item, width),
    [item, width],
  );
  const marker = activityMarker(item, animation, frameRef.current);
  const selectableLineTexts = useMemo(() => {
    const firstPrefix = `activity  ${marker} ${item ? `${item.label}${presentation.taskRef} ` : ""}`;
    return presentation.lines.slice(0, height).map((line, lineIndex) => `${lineIndex === 0
      ? firstPrefix
      : " ".repeat(presentation.prefixWidth)}${line.map((span) => span.text).join("")}`);
  }, [height, item, marker, presentation]);

  useEffect(() => {
    onVisibleLinesChange?.(height === 0 ? [] : selectableLineTexts);
  }, [height, onVisibleLinesChange, selectableLineTexts]);

  // Keep periodic marker updates out of React so Ink never walks the prompt
  // cursor through the full output tree for an animation frame.
  useEffect(() => {
    frameRef.current = 0;
    if (!animation) return;
    const frames = animation === "breathing"
      ? BREATHING_FRAMES
      : animation === "fold"
        ? FOLD_FRAMES
        : PROCESS_FRAMES;
    const frameMs = animation === "breathing"
      ? BREATHING_FRAME_MS
      : animation === "fold"
        ? FOLD_FRAME_MS
        : PROCESS_FRAME_MS;
    if (!stdout.isTTY || height === 0) return;
    let currentFrame = 0;
    const timer = setInterval(() => {
      currentFrame = (currentFrame + 1) % frames.length;
      const marker = frames[currentFrame];
      if (!marker) return;
      stdout.write(
        ansiEscapes.cursorSavePosition
          + ansiEscapes.cursorTo(screenX + terminalDisplayWidth("activity  "), screenY)
          + marker
          + ansiEscapes.cursorRestorePosition,
      );
    }, frameMs);
    return () => clearInterval(timer);
  }, [animation, height, screenX, screenY, stdout]);

  if (height === 0) return null;
  const contextCompactionFailed = item?.type === "contextCompaction"
    && (item.status === "failed" || item.status === "blocked" || item.status === "cancelled");
  const markerColor = animation === "fold"
    || (item?.type === "contextCompaction" && !contextCompactionFailed)
    ? "gray"
    : animation === "breathing"
    ? "white"
    : animation === "process" || item?.status === "inProgress"
      ? roleColor(item?.role)
      : statusColor(item?.status);
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      flexShrink={0}
      overflow="hidden"
    >
      {presentation.lines.map((line, lineIndex) => (
        <Text key={lineIndex}>
          {lineIndex === 0
            ? (
              <>
                <Text dimColor>activity  </Text>
                <Text
                  color={markerColor}
                  bold={animation === "breathing"}
                  dimColor={!item || animation === "fold" || item?.type === "contextCompaction"}
                >
                  {marker}
                </Text>
                <Text> </Text>
                {item
                  ? (
                    <>
                      <Text color={roleColor(item.role)} bold>{item.label}</Text>
                      <Text color={statusColor(item.status)}>{presentation.taskRef}</Text>
                      <Text> </Text>
                    </>
                  )
                  : null}
              </>
            )
            : <Text>{" ".repeat(presentation.prefixWidth)}</Text>}
          {line.map((span, spanIndex) => (
            <Text
              key={`${spanIndex}:${span.text}`}
              bold={span.style?.bold}
              italic={span.style?.italic}
              underline={span.style?.underline}
              strikethrough={span.style?.strikethrough}
              inverse={span.style?.inverse}
              color={span.style?.color}
              dimColor={span.style?.dimColor}
            >
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

/** Returns the number of rows the activity strip will occupy at the given width. */
export function resolveActivityBarRows(
  item: TuiAgentActivityStripItem | undefined,
  width: number,
): number {
  return buildActivityBarPresentation(item, width).lines.length;
}

/** Converts an activity item into wrapped terminal spans without changing activity content. */
export function buildActivityBarPresentation(
  item: TuiAgentActivityStripItem | undefined,
  width: number,
): ActivityBarPresentation {
  const taskSequence = item?.taskId?.match(/-task-(\d+)$/)?.[1];
  const taskRef = width >= 64 && taskSequence ? `:t-${taskSequence}` : "";
  const agentPrefix = item ? `${item.label}${taskRef} ` : "";
  const prefixWidth = terminalDisplayWidth(`activity  · ${agentPrefix}`);
  const bodyWidth = Math.max(1, width - prefixWidth);
  const lines = item?.markdown
    ? buildTerminalMarkdownLines(item.activity, bodyWidth)
      .filter((line) => line.kind !== "blank")
      .map((line) => line.spans)
    : wrapByDisplayWidth(item?.activity ?? "idle", bodyWidth)
      .map((line) => [{ text: line }]);
  return {
    lines: lines.length > 0 ? lines : [[{ text: item?.activity ?? "idle" }]],
    prefixWidth,
    taskRef,
  };
}

function activityAnimation(
  item: TuiAgentActivityStripItem | undefined,
  motionEnabled: boolean,
): ActivityAnimation | undefined {
  if (!motionEnabled) return undefined;
  if (item?.type === "contextCompaction" && item.status === "inProgress") return "fold";
  if (item?.processing) return "process";
  if (item?.status !== "inProgress") return undefined;
  if (item.type === "reasoning" || TOOL_ACTIVITY_TYPES.has(item.type)) {
    return "breathing";
  }
  return undefined;
}

function initialActivityAnimation(
  item: TuiAgentActivityStripItem | undefined,
  requested: ActivityAnimation | undefined,
  motionEnabled: boolean,
): ActivityAnimation | undefined {
  if (!motionEnabled) return undefined;
  if (item?.type === "contextCompaction" && item.status === "completed") return "fold";
  return shouldCompleteBreathingCycle(item, requested) ? "breathing" : requested;
}

function shouldCompleteBreathingCycle(
  item: TuiAgentActivityStripItem | undefined,
  requested: ActivityAnimation | undefined,
): boolean {
  return requested === "process"
    && (item?.type === "reasoning" || TOOL_ACTIVITY_TYPES.has(item?.type ?? ""));
}

function activityMarker(
  item: TuiAgentActivityStripItem | undefined,
  animation: ActivityAnimation | undefined,
  frame: number,
): string {
  if (!item) return "·";
  if (animation === "breathing") return BREATHING_FRAMES[frame % BREATHING_FRAMES.length];
  if (animation === "process") return PROCESS_FRAMES[frame % PROCESS_FRAMES.length];
  if (animation === "fold") return FOLD_FRAMES[frame % FOLD_FRAMES.length];
  if (item.status === "failed" || item.status === "blocked" || item.status === "cancelled") return "!";
  if (item.type === "contextCompaction") {
    return item.status === "inProgress" ? "▪" : "·";
  }
  if (item.status === "inProgress") return "›";
  return "-";
}

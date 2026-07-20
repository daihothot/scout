import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { TuiAgentActivityStripItem } from "../selectors/activity-strip.js";
import {
  buildTerminalMarkdownLines,
  type TerminalMarkdownSpan,
} from "../terminal-markdown.js";
import { roleColor, statusColor } from "../theme.js";
import { terminalDisplayWidth, wrapByDisplayWidth } from "../terminal-text.js";

const BREATHING_FRAMES = ["·", "◌", "○", "◉", "○", "◌"] as const;
const PROCESS_FRAMES = ["›", "▷", "▶", "▷"] as const;
const BREATHING_FRAME_MS = 120;
const BREATHING_CYCLE_MS = BREATHING_FRAMES.length * BREATHING_FRAME_MS;
const TOOL_ACTIVITY_TYPES = new Set([
  "commandExecution",
  "mcpToolCall",
  "fileChange",
]);

type ActivityAnimation = "breathing" | "process";

export interface ActivityBarPresentation {
  lines: TerminalMarkdownSpan[][];
  prefixWidth: number;
  taskRef: string;
}

export function ActivityBar({ item, width, height }: {
  item?: TuiAgentActivityStripItem;
  width: number;
  height: number;
}) {
  const requestedAnimation = activityAnimation(item);
  const [animation, setAnimation] = useState<ActivityAnimation | undefined>(() =>
    initialActivityAnimation(item, requestedAnimation)
  );
  const [frame, setFrame] = useState(0);
  const activityId = item?.activityId;
  const activityIdRef = useRef(activityId);
  const animationRef = useRef(animation);
  const breathingStartedAtRef = useRef<number | undefined>(
    animation === "breathing" ? Date.now() : undefined,
  );

  useEffect(() => {
    let transitionTimer: ReturnType<typeof setTimeout> | undefined;
    const transition = (next: ActivityAnimation | undefined) => {
      animationRef.current = next;
      setAnimation(next);
    };
    const startBreathing = (next: ActivityAnimation | undefined) => {
      breathingStartedAtRef.current = Date.now();
      transition("breathing");
      if (next !== "breathing") {
        transitionTimer = setTimeout(() => {
          breathingStartedAtRef.current = undefined;
          transition(next);
        }, BREATHING_CYCLE_MS);
      }
    };

    if (activityIdRef.current !== activityId) {
      activityIdRef.current = activityId;
      setFrame(0);
      if (shouldCompleteBreathingCycle(item, requestedAnimation)) {
        startBreathing(requestedAnimation);
      } else {
        breathingStartedAtRef.current = requestedAnimation === "breathing"
          ? Date.now()
          : undefined;
        transition(requestedAnimation);
      }
      return () => clearTimeout(transitionTimer);
    }

    if (requestedAnimation === "breathing") {
      if (animationRef.current !== "breathing") {
        setFrame(0);
        startBreathing("breathing");
      }
      return () => clearTimeout(transitionTimer);
    }

    if (animationRef.current === "breathing") {
      const elapsed = Date.now() - (breathingStartedAtRef.current ?? Date.now());
      const remaining = Math.max(0, BREATHING_CYCLE_MS - elapsed);
      if (remaining > 0) {
        transitionTimer = setTimeout(() => {
          breathingStartedAtRef.current = undefined;
          transition(requestedAnimation);
        }, remaining);
      } else {
        breathingStartedAtRef.current = undefined;
        transition(requestedAnimation);
      }
    } else {
      transition(requestedAnimation);
    }
    return () => clearTimeout(transitionTimer);
  }, [activityId, item?.type, requestedAnimation]);

  useEffect(() => {
    setFrame(0);
    if (!animation) return;
    const frames = animation === "breathing" ? BREATHING_FRAMES : PROCESS_FRAMES;
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % frames.length);
    }, animation === "breathing" ? BREATHING_FRAME_MS : 90);
    return () => clearInterval(timer);
  }, [animation]);

  if (height === 0) return null;
  const presentation = buildActivityBarPresentation(item, width);
  const marker = activityMarker(item, animation, frame);
  const markerColor = animation === "breathing"
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
                  dimColor={!item}
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

export function resolveActivityBarRows(
  item: TuiAgentActivityStripItem | undefined,
  width: number,
): number {
  return buildActivityBarPresentation(item, width).lines.length;
}

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
): ActivityAnimation | undefined {
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
): ActivityAnimation | undefined {
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
  if (item.status === "failed" || item.status === "blocked") return "!";
  if (item.status === "inProgress") return "›";
  return "-";
}

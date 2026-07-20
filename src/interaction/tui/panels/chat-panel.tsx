import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  mouseWheelDelta,
  parseSgrMouseEvent,
  resolveActivityScrollTop,
  scrollActivity,
} from "../activity-viewport.js";
import type { TuiChatItem } from "../selectors/chat-items.js";
import {
  buildCoordinatorMessageRows,
  CoordinatorMessageRow,
  type CoordinatorMessageVisualRow,
} from "../rows/coordinator-message-row.js";
import {
  buildSystemEventRows,
  SystemEventRow,
  type SystemEventVisualRow,
} from "../rows/system-event-row.js";
import {
  buildUserMessageRows,
  UserMessageRow,
  type UserMessageVisualRow,
} from "../rows/user-message-row.js";

type ChatVisualRow =
  | UserMessageVisualRow
  | CoordinatorMessageVisualRow
  | SystemEventVisualRow
  | { id: string; kind: "spacer" };

export function ChatPanel({
  items,
  width,
  height,
  startY,
  keyboardActive,
}: {
  items: TuiChatItem[];
  width: number;
  height: number;
  startY: number;
  keyboardActive: boolean;
}) {
  const [scrollTop, setScrollTop] = useState<number | null>(null);
  const rows = useMemo(() => buildChatVisualRows(items, width), [items, width]);
  const resolvedScrollTop = resolveActivityScrollTop(rows.length, height, scrollTop);
  const visibleRows = rows.slice(resolvedScrollTop, resolvedScrollTop + height);

  useEffect(() => {
    if (scrollTop === null || scrollTop === resolvedScrollTop) return;
    setScrollTop(resolvedScrollTop);
  }, [resolvedScrollTop, scrollTop]);

  const scrollBy = (delta: number) => {
    setScrollTop((current) => scrollActivity(rows.length, height, current, delta));
  };

  useInput((value, key) => {
    const mouse = parseSgrMouseEvent(value);
    if (mouse && mouse.y >= startY && mouse.y < startY + height) {
      const delta = mouseWheelDelta(mouse);
      if (delta !== undefined) scrollBy(delta);
      return;
    }
    if (!keyboardActive) return;
    if (key.pageUp) {
      scrollBy(-height);
      return;
    }
    if (key.pageDown) {
      scrollBy(height);
      return;
    }
    if (key.home) {
      setScrollTop(rows.length > height ? 0 : null);
      return;
    }
    if (key.end) setScrollTop(null);
  });

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      overflow="hidden"
      flexShrink={0}
    >
      {rows.length === 0
        ? <Text dimColor>Waiting for conversation.</Text>
        : visibleRows.map((row) => {
          if (row.kind === "spacer") return <Text key={row.id}> </Text>;
          if (row.kind === "user") return <UserMessageRow key={row.id} row={row} />;
          if (row.kind === "coordinator") {
            return <CoordinatorMessageRow key={row.id} row={row} />;
          }
          return <SystemEventRow key={row.id} row={row} />;
        })}
    </Box>
  );
}

export function buildChatVisualRows(items: TuiChatItem[], width: number): ChatVisualRow[] {
  return items.flatMap((item, index) => {
    const rows = item.kind === "user"
      ? buildUserMessageRows(item, width)
      : item.kind === "coordinator"
        ? buildCoordinatorMessageRows(item, width)
        : buildSystemEventRows(item, width);
    return index < items.length - 1
      ? [...rows, { id: `${item.id}:spacer`, kind: "spacer" as const }]
      : rows;
  });
}

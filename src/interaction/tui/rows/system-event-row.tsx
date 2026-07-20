import React from "react";
import { Text } from "ink";
import type { TuiSystemChatItem } from "../selectors/chat-items.js";
import {
  terminalDisplayWidth,
  wrapByDisplayWidth,
} from "../terminal-text.js";

const LABEL = "SYSTEM";
const MIN_INLINE_BODY_WIDTH = 16;

export interface SystemEventVisualRow {
  id: string;
  kind: "system";
  first: boolean;
  leadingWidth: number;
  text: string;
  level?: string;
  prefixOnly?: boolean;
}

export function buildSystemEventRows(
  item: TuiSystemChatItem,
  width: number,
): SystemEventVisualRow[] {
  const prefixWidth = terminalDisplayWidth(LABEL) + 1;
  const stackPrefix = width < prefixWidth + MIN_INLINE_BODY_WIDTH;
  const bodyWidth = Math.max(1, stackPrefix ? width : width - prefixWidth);
  const content = wrapByDisplayWidth(item.text, bodyWidth);
  if (stackPrefix) {
    return [
      {
        id: `${item.id}:prefix`,
        kind: "system",
        first: true,
        leadingWidth: prefixWidth,
        text: "",
        level: item.level,
        prefixOnly: true,
      },
      ...content.map((text, index) => ({
        id: `${item.id}:row:${index}`,
        kind: "system" as const,
        first: false,
        leadingWidth: 0,
        text,
        level: item.level,
      })),
    ];
  }
  return content.map((text, index) => ({
    id: `${item.id}:row:${index}`,
    kind: "system",
    first: index === 0,
    leadingWidth: prefixWidth,
    text,
    level: item.level,
  }));
}

export function SystemEventRow({ row }: { row: SystemEventVisualRow }) {
  const color = row.level === "error" ? "red" : row.level === "warn" ? "yellow" : "gray";
  return (
    <Text wrap="truncate-end" dimColor={row.level !== "error"}>
      {row.first
        ? <><Text color={color} bold>{LABEL}</Text><Text> </Text></>
        : <Text>{" ".repeat(row.leadingWidth)}</Text>}
      {!row.prefixOnly && <Text color={row.level === "error" ? "red" : undefined}>{row.text}</Text>}
    </Text>
  );
}

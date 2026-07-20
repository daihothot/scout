import React from "react";
import { Text } from "ink";
import type { TuiCoordinatorChatItem } from "../selectors/chat-items.js";
import {
  buildTerminalMarkdownLines,
  type TerminalMarkdownSpan,
} from "../terminal-markdown.js";
import { terminalDisplayWidth } from "../terminal-text.js";

const LABEL = "COORD";
const MIN_INLINE_BODY_WIDTH = 16;

export interface CoordinatorMessageVisualRow {
  id: string;
  kind: "coordinator";
  first: boolean;
  leadingWidth: number;
  text: string;
  spans?: TerminalMarkdownSpan[];
  prefixOnly?: boolean;
}

export function buildCoordinatorMessageRows(
  item: TuiCoordinatorChatItem,
  width: number,
): CoordinatorMessageVisualRow[] {
  const prefixWidth = terminalDisplayWidth(LABEL) + 1;
  const stackPrefix = width < prefixWidth + MIN_INLINE_BODY_WIDTH;
  const bodyWidth = Math.max(1, stackPrefix ? width : width - prefixWidth);
  const content = buildTerminalMarkdownLines(item.text, bodyWidth).map((line) => ({
    text: line.spans.map((span) => span.text).join(""),
    spans: line.spans,
  }));
  if (stackPrefix) {
    return [
      {
        id: `${item.id}:prefix`,
        kind: "coordinator",
        first: true,
        leadingWidth: prefixWidth,
        text: "",
        prefixOnly: true,
      },
      ...content.map((line, index) => ({
        id: `${item.id}:row:${index}`,
        kind: "coordinator" as const,
        first: false,
        leadingWidth: 0,
        text: line.text,
        spans: line.spans,
      })),
    ];
  }
  return content.map((line, index) => ({
    id: `${item.id}:row:${index}`,
    kind: "coordinator",
    first: index === 0,
    leadingWidth: prefixWidth,
    text: line.text,
    spans: line.spans,
  }));
}

export function CoordinatorMessageRow({ row }: { row: CoordinatorMessageVisualRow }) {
  return (
    <Text wrap="truncate-end">
      {row.first
        ? <><Text color="cyan" bold>{LABEL}</Text><Text> </Text></>
        : <Text>{" ".repeat(row.leadingWidth)}</Text>}
      {!row.prefixOnly && (
        <Text>
          {(row.spans ?? [{ text: row.text }]).map((span, index) => (
            <Text
              key={`${index}:${span.text}`}
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
      )}
    </Text>
  );
}

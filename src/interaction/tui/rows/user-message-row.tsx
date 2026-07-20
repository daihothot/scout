import React from "react";
import { Text } from "ink";
import type { TuiUserChatItem } from "../selectors/chat-items.js";
import {
  terminalDisplayWidth,
  wrapByDisplayWidth,
} from "../terminal-text.js";

const LABEL = "YOU";
const MIN_INLINE_BODY_WIDTH = 16;

export interface UserMessageVisualRow {
  id: string;
  kind: "user";
  first: boolean;
  leadingWidth: number;
  text: string;
  prefixOnly?: boolean;
}

export function buildUserMessageRows(
  item: TuiUserChatItem,
  width: number,
): UserMessageVisualRow[] {
  const prefixWidth = terminalDisplayWidth(LABEL) + 1;
  const stackPrefix = width < prefixWidth + MIN_INLINE_BODY_WIDTH;
  const bodyWidth = Math.max(1, stackPrefix ? width : width - prefixWidth);
  const content = wrapByDisplayWidth(item.text, bodyWidth);
  if (stackPrefix) {
    return [
      {
        id: `${item.id}:prefix`,
        kind: "user",
        first: true,
        leadingWidth: prefixWidth,
        text: "",
        prefixOnly: true,
      },
      ...content.map((text, index) => ({
        id: `${item.id}:row:${index}`,
        kind: "user" as const,
        first: false,
        leadingWidth: 0,
        text,
      })),
    ];
  }
  return content.map((text, index) => ({
    id: `${item.id}:row:${index}`,
    kind: "user",
    first: index === 0,
    leadingWidth: prefixWidth,
    text,
  }));
}

export function UserMessageRow({ row }: { row: UserMessageVisualRow }) {
  return (
    <Text wrap="truncate-end">
      {row.first
        ? <><Text color="yellow" bold>{LABEL}</Text><Text> </Text></>
        : <Text>{" ".repeat(row.leadingWidth)}</Text>}
      {!row.prefixOnly && <Text>{row.text}</Text>}
    </Text>
  );
}

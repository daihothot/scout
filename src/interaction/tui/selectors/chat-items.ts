import type { TuiState } from "../tui-store.js";

/** Discriminated chat projection consumed by the chat panel. */
export type TuiChatItem =
  | TuiUserChatItem
  | TuiCoordinatorChatItem
  | TuiSystemChatItem;

/** User-authored message projected into chat rows. */
export interface TuiUserChatItem {
  id: string;
  kind: "user";
  text: string;
  createdAt: string;
}

/** Coordinator message projected into markdown-aware chat rows. */
export interface TuiCoordinatorChatItem {
  id: string;
  kind: "coordinator";
  text: string;
  createdAt: string;
}

/** Runtime disclosure projected into a system chat row. */
export interface TuiSystemChatItem {
  id: string;
  kind: "system";
  text: string;
  level?: string;
  createdAt: string;
}

/** Selects and orders user, coordinator, and system chat records. */
export function selectChatItems(state: TuiState): TuiChatItem[] {
  return state.logs.map((entry): TuiChatItem => {
    if (entry.kind === "input") {
      return {
        id: entry.id,
        kind: "user",
        text: entry.text,
        createdAt: entry.createdAt,
      };
    }
    if (entry.kind === "agent") {
      return {
        id: entry.id,
        kind: "coordinator",
        text: entry.text,
        createdAt: entry.createdAt,
      };
    }
    return {
      id: entry.id,
      kind: "system",
      text: entry.text,
      level: entry.level,
      createdAt: entry.createdAt,
    };
  });
}

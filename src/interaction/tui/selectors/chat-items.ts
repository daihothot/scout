import type { TuiState } from "../tui-store.js";

export type TuiChatItem =
  | TuiUserChatItem
  | TuiCoordinatorChatItem
  | TuiSystemChatItem;

export interface TuiUserChatItem {
  id: string;
  kind: "user";
  text: string;
  createdAt: string;
}

export interface TuiCoordinatorChatItem {
  id: string;
  kind: "coordinator";
  text: string;
  createdAt: string;
}

export interface TuiSystemChatItem {
  id: string;
  kind: "system";
  text: string;
  level?: string;
  createdAt: string;
}

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
    if (entry.kind === "agent" && entry.agentId === "coordinator") {
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

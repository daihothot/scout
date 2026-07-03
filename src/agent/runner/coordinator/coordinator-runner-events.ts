import { event } from "../../../core/events/index.js";
import { SystemEvents } from "../../../system/events/catalog.js";
import type { ScoutAgentTurnResult } from "../../core/scout-agent.js";

const coordinatorRunnerEventCatalog = {
  coordinator: {
    messageProduced: event(),
    turnCompleted: event(),
  },
} as const;

SystemEvents.add(coordinatorRunnerEventCatalog);

export type CoordinatorRunnerEventCatalog = typeof coordinatorRunnerEventCatalog;

export interface CoordinatorMessageProducedPayload {
  messageId: string;
  agentId: string;
  threadId?: string;
  turnId?: string;
  text: string;
  createdAt: string;
  data?: unknown;
}

export interface CoordinatorTurnCompletedPayload {
  agentId: string;
  threadId?: string;
  turnId?: string;
  status: ScoutAgentTurnResult["status"];
  completedAt: string;
  turn: ScoutAgentTurnResult;
}

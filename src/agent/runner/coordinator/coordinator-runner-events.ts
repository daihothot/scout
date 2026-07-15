import { event } from "../../../core/events/index.js";
import { AgentEvents } from "../../events/catalog.js";
import type { ScoutAgentTurnRecord } from "../../core/scout-agent.js";

const coordinatorRunnerEventCatalog = {
  coordinator: {
    messageProduced: event(),
    turnCompleted: event(),
  },
} as const;

AgentEvents.add(coordinatorRunnerEventCatalog);

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
  status: ScoutAgentTurnRecord["status"];
  completedAt: string;
  turn: ScoutAgentTurnRecord;
}

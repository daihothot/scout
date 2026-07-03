import { event } from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/catalog.js";
import type { ScoutAgentTurnResult } from "../core/scout-agent.js";

const runnerEventCatalog = {
  system: {
    dispatchRequested: event(),
  },
  agent: {
    messageProduced: event(),
    turnCompleted: event(),
  },
} as const;

SystemEvents.add(runnerEventCatalog);

export type RunnerEventCatalog = typeof runnerEventCatalog;

export interface SystemDispatchRequestedPayload {
  dispatchId: string;
  reason: "runtime_events" | "system_interrupt" | "system_error" | "system_message";
  systemMessage?: string;
  createdAt: string;
  data?: unknown;
}

export interface AgentMessageProducedPayload {
  messageId: string;
  agentId: string;
  threadId?: string;
  turnId?: string;
  text: string;
  createdAt: string;
  data?: unknown;
}

export interface AgentTurnCompletedPayload {
  agentId: string;
  threadId?: string;
  turnId?: string;
  status: ScoutAgentTurnResult["status"];
  completedAt: string;
  turn: ScoutAgentTurnResult;
}

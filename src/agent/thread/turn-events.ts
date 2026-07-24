import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type {
  ScoutAgentTurnRecord,
} from "../core/scout-agent.js";
import type { ScoutAgentRole } from "./types.js";

export interface AgentTurnStartedEvent {
  invocationId: string;
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  prompt: string;
  startedAt: string;
}

export interface AgentTurnCompletedEvent {
  taskId?: string;
  turn: ScoutAgentTurnRecord;
}

export interface AgentTurnInterruptedEvent {
  invocationId: string;
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  reason: string;
  interruptedAt: string;
}

const agentTurnEventCatalog = {
  turn: {
    started: event<AgentTurnStartedEvent>(),
    completed: event<AgentTurnCompletedEvent>(),
    interrupted: event<AgentTurnInterruptedEvent>(),
  },
} as const;

AgentEvents.add(agentTurnEventCatalog);

export type AgentTurnEventCatalog = typeof agentTurnEventCatalog;

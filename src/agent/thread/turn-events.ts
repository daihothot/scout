import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type {
  ScoutAgentTurnRecord,
} from "../core/scout-agent.js";
import type { ScoutAgentRole } from "./types.js";

/** Fact emitted before an app-server turn is submitted. */
export interface AgentTurnStartedEvent {
  invocationId: string;
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  prompt: string;
  startedAt: string;
}

/** Fact emitted after a turn reaches a terminal status. */
export interface AgentTurnCompletedEvent {
  taskId?: string;
  turn: ScoutAgentTurnRecord;
}

/** Fact emitted when Runtime interrupts a turn before normal completion. */
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

/** Event routes for turn lifecycle facts. */
export type AgentTurnEventCatalog = typeof agentTurnEventCatalog;

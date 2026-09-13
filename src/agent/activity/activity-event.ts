import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { ScoutAgentRole } from "../thread/types.js";

/** A normalized progress item projected from an app-server timeline entry. */
export interface AgentActivity {
  seq: number;
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  turnId?: string;
  itemId: string;
  type: string;
  status: string;
  label: string;
  detail?: string;
  updatedAt: string;
}

/** A turn lifecycle observation emitted independently from item progress. */
export interface AgentTurnActivity {
  seq: number;
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  turnId: string;
  status: string;
  updatedAt: string;
}

const agentActivityEventCatalog = {
  activity: {
    observed: event<AgentActivity>(),
    turnObserved: event<AgentTurnActivity>(),
  },
} as const;

AgentEvents.add(agentActivityEventCatalog);

/** Event routes owned by the agent activity projection. */
export type AgentActivityEventCatalog = typeof agentActivityEventCatalog;

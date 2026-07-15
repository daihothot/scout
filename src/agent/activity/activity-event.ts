import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { ScoutAgentRole } from "../thread/types.js";

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

const agentActivityEventCatalog = {
  activity: {
    observed: event<AgentActivity>(),
  },
} as const;

AgentEvents.add(agentActivityEventCatalog);

export type AgentActivityEventCatalog = typeof agentActivityEventCatalog;

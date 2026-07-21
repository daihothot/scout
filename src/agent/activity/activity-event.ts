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

interface AgentNativeSubagentActivityBase {
  seq: number;
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  turnId?: string;
  itemId: string;
  updatedAt: string;
}

export interface AgentNativeSubagentToolActivity extends AgentNativeSubagentActivityBase {
  type: "collabAgentToolCall";
  tool: string;
  status: string;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentsStates: Record<string, {
    status: string;
    message: string | null;
  }>;
}

export interface AgentNativeSubagentLifecycleActivity extends AgentNativeSubagentActivityBase {
  type: "subAgentActivity";
  kind: string;
  agentThreadId: string;
  agentPath: string;
}

export type AgentNativeSubagentActivity =
  | AgentNativeSubagentToolActivity
  | AgentNativeSubagentLifecycleActivity;

const agentActivityEventCatalog = {
  activity: {
    observed: event<AgentActivity>(),
    turnObserved: event<AgentTurnActivity>(),
    nativeSubagentObserved: event<AgentNativeSubagentActivity>(),
  },
} as const;

AgentEvents.add(agentActivityEventCatalog);

export type AgentActivityEventCatalog = typeof agentActivityEventCatalog;

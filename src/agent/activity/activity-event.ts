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

/** Shared identity carried by native subagent lifecycle projections. */
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

/** A native collaboration tool call with the server-reported child states. */
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

/** A native subagent lifecycle item projected without rewriting its state. */
export interface AgentNativeSubagentLifecycleActivity extends AgentNativeSubagentActivityBase {
  type: "subAgentActivity";
  kind: string;
  agentThreadId: string;
  agentPath: string;
}

/** The discriminated native-subagent activity forms accepted by the event bus. */
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

/** Event routes owned by the agent activity projection. */
export type AgentActivityEventCatalog = typeof agentActivityEventCatalog;

import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { ScoutAgentRole } from "../thread/types.js";

/** Shared identity carried by native subagent facts. */
interface AgentNativeSubagentEventBase {
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
export interface AgentNativeSubagentToolEvent extends AgentNativeSubagentEventBase {
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

/** A native subagent lifecycle fact projected without rewriting its state. */
export interface AgentNativeSubagentLifecycleEvent extends AgentNativeSubagentEventBase {
  type: "subAgentActivity";
  kind: string;
  agentThreadId: string;
  agentPath: string;
}

/** Native subagent facts emitted by the app-server timeline adapter. */
export type AgentNativeSubagentEvent =
  | AgentNativeSubagentToolEvent
  | AgentNativeSubagentLifecycleEvent;

const agentSubagentEventCatalog = {
  subagent: {
    observed: event<AgentNativeSubagentEvent>(),
  },
} as const;

AgentEvents.add(agentSubagentEventCatalog);

/** Event routes owned by native subagent observation. */
export type AgentSubagentEventCatalog = typeof agentSubagentEventCatalog;

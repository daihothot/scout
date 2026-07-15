import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";

const orchestratorEventCatalog = {
  orchestration: {
    dispatchRequested: event(),
  },
  interrupt: {
    raised: event(),
    resolved: event(),
    cancelled: event(),
    failed: event(),
  },
} as const;

AgentEvents.add(orchestratorEventCatalog);

export type OrchestratorEventCatalog = typeof orchestratorEventCatalog;

export type AgentInterruptKind =
  | "tool_call"
  | "approval"
  | "exception"
  | "policy_block";

export interface AgentInterruptEventPayload {
  runId?: string;
  interruptKind: AgentInterruptKind;
  attachment: string;
  taskId?: string;
  agentId?: string;
  turnId?: string;
  requestId?: string;
}

export interface AgentOrchestrationDispatchRequestedPayload {
  dispatchId: string;
  reason: "runtime_events" | "agent_interrupt" | "agent_error" | "agent_message";
  message?: string;
  createdAt: string;
  attachment: string;
  data?: unknown;
}

import { event } from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/catalog.js";

const orchestratorEventCatalog = {
  system: {
    dispatchRequested: event(),
  },
  interrupt: {
    raised: event(),
    resolved: event(),
    cancelled: event(),
    failed: event(),
  },
} as const;

SystemEvents.add(orchestratorEventCatalog);

export type OrchestratorEventCatalog = typeof orchestratorEventCatalog;

export type SystemInterruptKind =
  | "human_input"
  | "tool_call"
  | "approval"
  | "exception"
  | "policy_block";

export interface SystemInterruptEventPayload {
  runId?: string;
  interruptKind: SystemInterruptKind;
  taskId?: string;
  agentId?: string;
  turnId?: string;
  requestId?: string;
}

export interface SystemDispatchRequestedPayload {
  dispatchId: string;
  reason: "runtime_events" | "system_interrupt" | "system_error" | "system_message";
  systemMessage?: string;
  createdAt: string;
  data?: unknown;
}

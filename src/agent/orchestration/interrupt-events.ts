import { event } from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/catalog.js";

const interruptEventCatalog = {
  interrupt: {
    raised: event(),
    resolved: event(),
    cancelled: event(),
    failed: event(),
  },
} as const;

SystemEvents.add(interruptEventCatalog);

export type SystemInterruptEventCatalog = typeof interruptEventCatalog;

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

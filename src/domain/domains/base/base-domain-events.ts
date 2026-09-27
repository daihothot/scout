import type { DynamicToolCallResponse } from "../../../agent-server/types.js";
import type {
  ScoutAgentPhase,
  ScoutAgentRole,
} from "../../../agent/thread/types.js";
import { defineEventCatalog, event } from "../../../core/events/index.js";

/** One completed Agent invocation of a shared Base Domain tool. */
export interface BaseDomainAgentToolCallObservedEvent {
  callId: string;
  threadId?: string;
  agentId: string;
  role: ScoutAgentRole;
  phase: ScoutAgentPhase;
  namespace: string;
  tool: string;
  arguments: unknown;
  response: DynamicToolCallResponse;
  startedAt: string;
  completedAt: string;
}

/** Facts owned by the shared Domain runtime rather than a specialized Domain. */
export const BaseDomainEvents = defineEventCatalog("domain.base", {
  agentToolCall: {
    observed: event<BaseDomainAgentToolCallObservedEvent>(),
  },
} as const);

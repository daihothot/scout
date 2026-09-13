import type { DynamicToolCallResponse } from "../agent-server/types.js";
import type {
  ScoutAgentPhase,
  ScoutAgentRole,
} from "../agent/thread/types.js";
import { defineEventCatalog, event } from "../core/events/index.js";

/** One completed Agent invocation of a Domain-owned dynamic tool. */
export interface DomainAgentToolCallObservedEvent {
  domainId: string;
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

/** Shared in-memory observation routes for Domain-owned operations. */
export const DomainEvents = defineEventCatalog("domain.shared", {
  agentToolCall: {
    observed: event<DomainAgentToolCallObservedEvent>(),
  },
} as const);

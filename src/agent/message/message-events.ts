import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { AgentMessage } from "./types.js";

/** Fact emitted after a queued agent message is consumed by its receiver. */
export interface AgentMessageConsumedEvent {
  messageId: string;
  agentId: string;
  taskId?: string;
  consumedAt: string;
}

const agentMessageEventCatalog = {
  message: {
    queued: event<AgentMessage>(),
    consumed: event<AgentMessageConsumedEvent>(),
  },
} as const;

AgentEvents.add(agentMessageEventCatalog);

/** Event routes for agent message delivery. */
export type AgentMessageEventCatalog = typeof agentMessageEventCatalog;

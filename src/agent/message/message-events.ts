import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { AgentMessage, AgentMessageDeliveryMode } from "./types.js";

/** Fact emitted after an agent message is accepted by its receiver. */
export interface AgentMessageConsumedEvent {
  messageId: string;
  agentId: string;
  stepId: string;
  taskId?: string;
  consumedAt: string;
  /** Actual delivery method used by the runner. */
  deliveryMode?: AgentMessageDeliveryMode;
  /** Active turn that accepted a steered message, when applicable. */
  turnId?: string;
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

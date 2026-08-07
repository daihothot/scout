import { event } from "../../../core/events/index.js";
import { AgentEvents } from "../../events/catalog.js";

const coordinatorRunnerEventCatalog = {
  coordinator: {
    messageProduced: event<CoordinatorMessageProducedPayload>(),
  },
} as const;

AgentEvents.add(coordinatorRunnerEventCatalog);

/** Event routes emitted when the Coordinator produces a user-facing message. */
export type CoordinatorRunnerEventCatalog = typeof coordinatorRunnerEventCatalog;

/** Durable projection of one Coordinator message production. */
export interface CoordinatorMessageProducedPayload {
  messageId: string;
  agentId: string;
  threadId?: string;
  turnId?: string;
  text: string;
  createdAt: string;
  data?: unknown;
}

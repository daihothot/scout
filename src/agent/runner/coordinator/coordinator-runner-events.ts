import { event } from "../../../core/events/index.js";
import { AgentEvents } from "../../events/catalog.js";

const coordinatorRunnerEventCatalog = {
  coordinator: {
    messageProduced: event<CoordinatorMessageProducedPayload>(),
  },
} as const;

AgentEvents.add(coordinatorRunnerEventCatalog);

export type CoordinatorRunnerEventCatalog = typeof coordinatorRunnerEventCatalog;

export interface CoordinatorMessageProducedPayload {
  messageId: string;
  agentId: string;
  threadId?: string;
  turnId?: string;
  text: string;
  createdAt: string;
  data?: unknown;
}

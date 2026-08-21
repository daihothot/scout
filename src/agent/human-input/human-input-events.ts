import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { AgentMessage } from "../message/types.js";

/** Fact emitted when a Worker asks the Coordinator to obtain user input. */
export interface AgentHumanInputRequestedEvent {
  requestId: string;
  stepId: string;
  taskId: string;
  agentId: string;
  body: string;
  requestedAt: string;
  message: AgentMessage;
}

/** Fact emitted when the Coordinator forwards the user's response. */
export interface AgentHumanInputRespondedEvent {
  requestId: string;
  stepId: string;
  taskId: string;
  agentId: string;
  body: string;
  respondedAt: string;
  message: AgentMessage;
}

const agentHumanInputEventCatalog = {
  humanInput: {
    requested: event<AgentHumanInputRequestedEvent>(),
    responded: event<AgentHumanInputRespondedEvent>(),
  },
} as const;

AgentEvents.add(agentHumanInputEventCatalog);

/** Event routes for request/response correlation owned by the human-input store. */
export type AgentHumanInputEventCatalog = typeof agentHumanInputEventCatalog;

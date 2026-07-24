import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { AgentMessage } from "../message/types.js";

export interface AgentHumanInputRequestedEvent {
  requestId: string;
  taskId: string;
  agentId: string;
  body: string;
  requestedAt: string;
  message: AgentMessage;
}

export interface AgentHumanInputRespondedEvent {
  requestId: string;
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

export type AgentHumanInputEventCatalog = typeof agentHumanInputEventCatalog;

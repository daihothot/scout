import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { AgentToolCallState } from "./types.js";

/** Published whenever a dynamic or MCP tool-call projection changes. */
const toolCallEventCatalog = {
  toolCall: {
    observed: event<AgentToolCallState>(),
  },
} as const;

AgentEvents.add(toolCallEventCatalog);

export type AgentToolCallEventCatalog = typeof toolCallEventCatalog;

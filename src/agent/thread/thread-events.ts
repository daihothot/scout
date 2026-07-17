import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { AgentThreadSnapshot } from "./types.js";

const agentThreadEventCatalog = {
  thread: {
    started: event<AgentThreadSnapshot>(),
    closed: event<AgentThreadSnapshot>(),
  },
} as const;

AgentEvents.add(agentThreadEventCatalog);

export type AgentThreadEventCatalog = typeof agentThreadEventCatalog;

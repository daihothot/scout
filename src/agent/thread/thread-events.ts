import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type {
  AgentThreadResumeRecord,
  AgentThreadSnapshot,
} from "./types.js";

const agentThreadEventCatalog = {
  thread: {
    started: event<AgentThreadSnapshot>(),
    resumed: event<AgentThreadResumeRecord>(),
    closed: event<AgentThreadSnapshot>(),
  },
} as const;

AgentEvents.add(agentThreadEventCatalog);

export type AgentThreadEventCatalog = typeof agentThreadEventCatalog;

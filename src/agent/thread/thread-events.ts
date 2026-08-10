import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type {
  AgentThreadRestartRecord,
  AgentThreadResumeRecord,
  AgentThreadSnapshot,
} from "./types.js";

const agentThreadEventCatalog = {
  thread: {
    started: event<AgentThreadSnapshot>(),
    resumed: event<AgentThreadResumeRecord>(),
    restarted: event<AgentThreadRestartRecord>(),
    closed: event<AgentThreadSnapshot>(),
  },
} as const;

AgentEvents.add(agentThreadEventCatalog);

/** Event routes for thread start, resume, restart, and close facts. */
export type AgentThreadEventCatalog = typeof agentThreadEventCatalog;

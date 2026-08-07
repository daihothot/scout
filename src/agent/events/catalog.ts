import { createEventCatalog } from "../../core/events/index.js";

/** Mutable registration point extended by each agent event module at import time. */
export const AgentEvents = createEventCatalog("agent");

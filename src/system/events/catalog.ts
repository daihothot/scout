import { createEventCatalog } from "../../core/events/index.js";

/** Shared registry for system-scoped event declarations, including interaction events. */
export const SystemEvents = createEventCatalog("system");

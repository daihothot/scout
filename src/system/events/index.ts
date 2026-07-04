import type { DefinedEventCatalog, EventCatalogRegistry } from "../../core/events/index.js";
import type { InteractionEventCatalog } from "../../interaction/gateway/interaction-events.js";

import "../../interaction/gateway/interaction-events.js";
import { SystemEvents as SystemEventCatalog } from "./catalog.js";

export const SystemEvents = SystemEventCatalog as EventCatalogRegistry<"system">
  & DefinedEventCatalog<InteractionEventCatalog>;

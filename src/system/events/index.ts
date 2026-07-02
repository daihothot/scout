import type { DefinedEventCatalog, EventCatalogRegistry } from "../../core/events/index.js";
import type { AgentTaskEventCatalog } from "../../agent/task/task-events.js";
import type { SystemInterruptEventCatalog } from "../../agent/orchestration/interrupt-events.js";
import type { RunnerEventCatalog } from "../../agent/runner/runner-events.js";
import type { InteractionEventCatalog } from "../../interaction/gateway/interaction-events.js";

import "../../agent/task/task-events.js";
import "../../agent/orchestration/interrupt-events.js";
import "../../agent/runner/runner-events.js";
import "../../interaction/gateway/interaction-events.js";
import { SystemEvents as SystemEventCatalog } from "./catalog.js";

export const SystemEvents = SystemEventCatalog as EventCatalogRegistry<"system">
  & DefinedEventCatalog<AgentTaskEventCatalog>
  & DefinedEventCatalog<SystemInterruptEventCatalog>
  & DefinedEventCatalog<RunnerEventCatalog>
  & DefinedEventCatalog<InteractionEventCatalog>;

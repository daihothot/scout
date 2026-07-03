import type { DefinedEventCatalog, EventCatalogRegistry } from "../../core/events/index.js";
import type { AgentTaskEventCatalog } from "../../agent/task/task-events.js";
import type { OrchestratorEventCatalog } from "../../agent/orchestration/orchestrator-events.js";
import type { CoordinatorRunnerEventCatalog } from "../../agent/runner/coordinator/coordinator-runner-events.js";
import type { InteractionEventCatalog } from "../../interaction/gateway/interaction-events.js";

import "../../agent/task/task-events.js";
import "../../agent/orchestration/orchestrator-events.js";
import "../../agent/runner/coordinator/coordinator-runner-events.js";
import "../../interaction/gateway/interaction-events.js";
import { SystemEvents as SystemEventCatalog } from "./catalog.js";

export const SystemEvents = SystemEventCatalog as EventCatalogRegistry<"system">
  & DefinedEventCatalog<AgentTaskEventCatalog>
  & DefinedEventCatalog<OrchestratorEventCatalog>
  & DefinedEventCatalog<CoordinatorRunnerEventCatalog>
  & DefinedEventCatalog<InteractionEventCatalog>;

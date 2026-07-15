import type { DefinedEventCatalog, EventCatalogRegistry } from "../../core/events/index.js";
import type { AgentTaskEventCatalog } from "../task/task-events.js";
import type { OrchestratorEventCatalog } from "../orchestration/orchestrator-events.js";
import type { CoordinatorRunnerEventCatalog } from "../runner/coordinator/coordinator-runner-events.js";
import type { AgentActivityEventCatalog } from "../activity/activity-event.js";

import "../activity/activity-event.js";
import "../task/task-events.js";
import "../orchestration/orchestrator-events.js";
import "../runner/coordinator/coordinator-runner-events.js";
import { AgentEvents as AgentEventCatalog } from "./catalog.js";

export const AgentEvents = AgentEventCatalog as EventCatalogRegistry<"agent">
  & DefinedEventCatalog<AgentActivityEventCatalog>
  & DefinedEventCatalog<AgentTaskEventCatalog>
  & DefinedEventCatalog<OrchestratorEventCatalog>
  & DefinedEventCatalog<CoordinatorRunnerEventCatalog>;

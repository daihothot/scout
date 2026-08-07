import type { DefinedEventCatalog, EventCatalogRegistry } from "../../core/events/index.js";
import type { AgentTaskEventCatalog } from "../task/task-events.js";
import type { CoordinatorRunnerEventCatalog } from "../runner/coordinator/coordinator-runner-events.js";
import type { AgentActivityEventCatalog } from "../activity/activity-event.js";
import type { AgentThreadEventCatalog } from "../thread/thread-events.js";
import type { AgentTurnEventCatalog } from "../thread/turn-events.js";
import type { AgentMessageEventCatalog } from "../message/message-events.js";
import type { AgentHumanInputEventCatalog } from "../human-input/human-input-events.js";
import type { AgentSkillEventCatalog } from "../skill/skill-events.js";

import "../activity/activity-event.js";
import "../thread/thread-events.js";
import "../thread/turn-events.js";
import "../message/message-events.js";
import "../human-input/human-input-events.js";
import "../task/task-events.js";
import "../runner/coordinator/coordinator-runner-events.js";
import "../skill/skill-events.js";
import { AgentEvents as AgentEventCatalog } from "./catalog.js";

/** Fully typed registry of all agent-owned event routes. */
export const AgentEvents = AgentEventCatalog as EventCatalogRegistry<"agent">
  & DefinedEventCatalog<AgentActivityEventCatalog>
  & DefinedEventCatalog<AgentThreadEventCatalog>
  & DefinedEventCatalog<AgentTurnEventCatalog>
  & DefinedEventCatalog<AgentMessageEventCatalog>
  & DefinedEventCatalog<AgentHumanInputEventCatalog>
  & DefinedEventCatalog<AgentTaskEventCatalog>
  & DefinedEventCatalog<CoordinatorRunnerEventCatalog>
  & DefinedEventCatalog<AgentSkillEventCatalog>;

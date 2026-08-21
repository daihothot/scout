import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { AgentStepState } from "./types.js";

const stepEventCatalog = {
  step: {
    started: event<AgentStepState>(),
    completed: event<AgentStepState>(),
    interrupted: event<AgentStepState>(),
    failed: event<AgentStepState>(),
    planUpdated: event<AgentStepState>(),
  },
} as const;

AgentEvents.add(stepEventCatalog);

export type AgentStepEventCatalog = typeof stepEventCatalog;

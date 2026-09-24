import { defineEventCatalog, event } from "../core/events/index.js";
import type {
  ExecutionCommandResult,
  ExecutionPlatformRequest,
} from "./execution-command.js";

export interface ExecutionCommandCompletedEvent {
  correlationId: string;
  request: ExecutionPlatformRequest;
  result: ExecutionCommandResult;
}

/** Facts emitted by the execution layer after each independent command completes. */
export const ExecutionEvents = defineEventCatalog("system", {
  execution: {
    identifyCompleted: event<ExecutionCommandCompletedEvent>(),
    launchCompleted: event<ExecutionCommandCompletedEvent>(),
    shutdownCompleted: event<ExecutionCommandCompletedEvent>(),
  },
} as const);

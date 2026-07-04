import type { ScoutEvent } from "../../core/events/index.js";
import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type {
  AgentTaskState,
  AgentTaskStep,
  AgentHumanInputRequest,
  AgentHumanInputResponse,
} from "./types.js";

const taskEventCatalog = {
  task: {
    assigned: event(),
    messageQueued: event(),
    stopped: event(),
    outcomeAccepted: event(),
    humanInputRequested: event(),
    humanInputResponded: event(),
    threadAttached: event(),
    pendingMessagesDrained: event(),
    stepStarted: event(),
    stepCompleted: event(),
    stepOutput: event(),
    failed: event(),
    goalUpdated: event(),
    planUpdated: event(),
    terminal: event(),
  },
} as const;

AgentEvents.add(taskEventCatalog);

export type AgentTaskEventCatalog = typeof taskEventCatalog;

export interface AgentTaskEventPayload {
  runId?: string;
  task: AgentTaskState;
  data?: unknown;
}

export interface AgentTaskStepEventPayload extends AgentTaskEventPayload {
  prompt?: string;
  step?: AgentTaskStep;
  output?: string;
}

export interface AgentTaskTerminalEventPayload extends AgentTaskEventPayload {
  result?: string;
  error?: string;
}

export interface AgentHumanInputRequestedEventPayload extends AgentTaskEventPayload {
  request: AgentHumanInputRequest;
}

export interface AgentHumanInputRespondedEventPayload extends AgentTaskEventPayload {
  response: AgentHumanInputResponse;
}

export type AgentTaskEventPayloadVariant =
  | AgentTaskEventPayload
  | AgentHumanInputRequestedEventPayload
  | AgentHumanInputRespondedEventPayload
  | AgentTaskStepEventPayload
  | AgentTaskTerminalEventPayload;

export type AgentTaskEvent = ScoutEvent<AgentTaskEventPayloadVariant>;

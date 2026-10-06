import type { ScoutAgentRole } from "../../../agent/thread/types.js";
import type { AgentJsonValue } from "../../../agent/tools/types.js";
import { defineEventCatalog, event } from "../../../core/events/index.js";
import type { HostCommandExecution } from "../../../host/host-command-executor.js";
import type { ExecutionPlatformIdentity } from "../../../execution/scout-execution-system.js";
import type { RbtExecutionHistory, RbtExecutionPackSubmission, RbtReviewSubmission } from "./artifacts/types.js";
import type { RbtPlatform } from "./config/index.js";

/** The platform selected for this Workflow; physical configuration stays in the Domain. */
export interface RbtExecutionSourceSelectedEvent {
  platform: RbtPlatform;
}

/** One host command executed while serving an RBT dynamic-tool call. */
export type RbtHostCommandExecution = HostCommandExecution;

/** Runtime Behavioral request after Scout run macros have been resolved. */
export interface RbtBehaviorRequest {
  type: string;
  version: number;
  correlationId: string;
  payload: Record<string, AgentJsonValue>;
}

/** Runtime Behavioral command result returned through Jarvis. */
export interface RbtBehaviorResult {
  type: string;
  version: number;
  correlationId: string;
  status: string;
  code: string;
  payload: AgentJsonValue;
}

/** One command fact belonging to an Executor campaign execution history. */
export interface RbtCampaignCommandEvent {
  bddId: string;
  targetVersion: string;
  executeFileRef: string;
  executeFileDigest: string;
  runtimeSequence: number;
  campaignId: string;
  scenarioId: string;
  runId: string;
  sequence: number;
  agentId: string;
  role: ScoutAgentRole;
  callId: string;
  platform: ExecutionPlatformIdentity;
  agentInput: AgentJsonValue;
  request: RbtBehaviorRequest;
  result?: RbtBehaviorResult;
  status: "completed" | "failed";
  error?: string;
  hostCommands: RbtHostCommandExecution[];
  startedAt: string;
  completedAt: string;
}

/** Runtime-owned history identity made available after one execution closes. */
export interface RbtExecutionHistoryReadyEvent extends RbtExecutionHistory {}

/** File identity emitted once after a Campaign execution history is finalized. */
export interface RbtCampaignExecutionHistoryFileEvent {
  agentId: string;
  role: ScoutAgentRole;
  runtimeSequence: number;
  executorHistoryRef: string;
  executorHistoryDigest: string;
}

/** A formal Executor handoff whose artifact identity was captured by the Domain. */
export interface RbtExecutionPackSubmittedEvent extends RbtExecutionPackSubmission {}

/** A formal Reviewer handoff linked to the exact execution and submitted Execution Pack. */
export interface RbtReviewSubmittedEvent extends RbtReviewSubmission {}

/** In-memory RBT observation routes consumed by Domain telemetry and artifacts. */
export const RbtEvents = defineEventCatalog("domain.rbt", {
  execution: {
    sourceSelected: event<RbtExecutionSourceSelectedEvent>(),
  },
  campaign: {
    start: event<RbtCampaignCommandEvent>(),
    command: event<RbtCampaignCommandEvent>(),
    end: event<RbtCampaignCommandEvent>(),
  },
  history: {
    campaignExecutionHistory: event<RbtCampaignExecutionHistoryFileEvent>(),
    ready: event<RbtExecutionHistoryReadyEvent>(),
  },
  artifact: {
    executionPackSubmitted: event<RbtExecutionPackSubmittedEvent>(),
    reviewSubmitted: event<RbtReviewSubmittedEvent>(),
  },
} as const);

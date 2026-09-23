import type { ScoutAgentRole } from "../../agent/thread/types.js";
import type { AgentJsonValue } from "../../agent/tools/types.js";
import { defineEventCatalog, event } from "../../core/events/index.js";
import type { HostCommandExecution } from "../../host/host-command-executor.js";
import type { ExecutionPlatformIdentity } from "../../execution/scout-execution-system.js";

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
export interface RbtExecutionHistoryReadyEvent {
  executorHistoryRef: string;
  executeFileRef: string;
  runtimeSequence: number;
  campaignId: string;
  scenarioId: string;
  status: "completed" | "failed";
  agentId: string;
  role: ScoutAgentRole;
}

/** In-memory RBT observation routes consumed by Domain telemetry and artifacts. */
export const RbtEvents = defineEventCatalog("domain.rbt", {
  campaign: {
    start: event<RbtCampaignCommandEvent>(),
    command: event<RbtCampaignCommandEvent>(),
    end: event<RbtCampaignCommandEvent>(),
  },
  history: {
    ready: event<RbtExecutionHistoryReadyEvent>(),
  },
} as const);

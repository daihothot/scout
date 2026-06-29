import type { AssetCommit, CodexMount } from "../../asset-store/index.js";
import type { RuntimeInteractionPort } from "../../interaction/index.js";
import type { RuntimeMessageQueueManager } from "../../core/queue/message-queue.js";
import type { ScoutAgentOptions } from "../scout-agent.js";
import type { ScoutAgentThreadPreflightRecord } from "./thread-preflight.js";
import type { AgentThreadRecord, ScoutAgentRole } from "../types.js";
import { ScoutAgentRoles } from "../types.js";
import type { AgentTaskState, AssignAgentTaskInput } from "../task/types.js";

export interface AgentBackendOptions extends ScoutAgentOptions {
  runId: string;
  ledgerRoot: string;
  agentMounts?: Partial<Record<ScoutAgentRole, CodexMount>>;
  agentAssetCommits?: Partial<Record<ScoutAgentRole, AssetCommit>>;
  messageQueue?: RuntimeMessageQueueManager;
  interactionPort?: RuntimeInteractionPort;
}

export interface CoordinatorSyntheticOutput {
  status: "in_progress" | "complete" | "blocked" | "failed";
  summary: string;
  evidence: string[];
  blocker?: string;
  emittedAt: string;
  coordinatorThreadId: string;
}

export interface ScoutAgentLedger {
  ledgerVersion: 1;
  runId: string;
  agents: AgentThreadRecord[];
  threadPreflights: ScoutAgentThreadPreflightRecord[];
  tasks: AgentTaskState[];
}

export type AssignBackendAgentTaskInput = Omit<AssignAgentTaskInput, "taskId" | "subagentType"> & {
  subagentType: Exclude<ScoutAgentRole, typeof ScoutAgentRoles.Coordinator>;
};

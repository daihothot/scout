import type { ScoutAgentRole } from "../../../agent/thread/types.js";
import {
  ResumeActionTypes,
  type ResumeAction,
  type TaskRecoveryCheckpoint,
} from "../projection/task-recovery.js";
import type { RunProjection } from "../projection/run-projector.js";

const MAX_TEXT_BYTES = 2 * 1024;

export interface ResumePacketInput {
  projection: RunProjection;
  agentId: string;
  role: ScoutAgentRole;
  assetCommitId: string;
  resumeActions: ResumeAction[];
}

export type ResumePacketAction =
  | {
    type: typeof ResumeActionTypes.ResumeTask;
    task_id: string;
    instruction: string;
  }
  | {
    type: typeof ResumeActionTypes.ConsumeMessage;
    message_id: string;
    instruction: string;
  }
  | {
    type: typeof ResumeActionTypes.InspectInterruption;
    task_id: string;
    instruction: string;
  }
  | {
    type: typeof ResumeActionTypes.EvaluateOutcome;
    task_id: string;
    instruction: string;
  }
  | {
    type: typeof ResumeActionTypes.ResolveTermination;
    task_id: string;
    instruction: string;
  };

export interface ResumePacket {
  identity: {
    run_id: string;
    checkpoint_seq: number;
    agent_id: string;
    role: ScoutAgentRole;
    asset_commit_id: string;
  };
  task_recovery_checkpoint?: TaskRecoveryCheckpoint;
  resume_actions: ResumePacketAction[];
  task?: Record<string, unknown>;
  tasks?: Array<Record<string, unknown>>;
  reported: Array<Record<string, unknown>>;
  confirmed: Array<Record<string, unknown>>;
  open: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  pending_messages: Array<Record<string, unknown>>;
}

export function renderIdentity(
  input: ResumePacketInput,
): ResumePacket["identity"] {
  return {
    run_id: input.projection.runId,
    checkpoint_seq: input.projection.checkpointSeq,
    agent_id: input.agentId,
    role: input.role,
    asset_commit_id: input.assetCommitId,
  };
}

export function renderArtifact(
  artifact: RunProjection["artifacts"][number],
): Record<string, unknown> {
  return {
    type: "artifact",
    artifact_id: artifact.artifactId,
    task_id: artifact.taskId,
    agent_id: artifact.agentId,
    role: artifact.role,
    ref: artifact.ref,
    digest: artifact.digest,
    status: artifact.status,
  };
}

export function renderResumeAction(action: ResumeAction): ResumePacketAction {
  switch (action.type) {
    case ResumeActionTypes.ResumeTask:
      return {
        type: action.type,
        task_id: action.taskId,
        instruction: "从已恢复的 Task 边界继续执行。",
      };
    case ResumeActionTypes.ConsumeMessage:
      return {
        type: action.type,
        message_id: action.messageId,
        instruction: "处理恢复前尚未消费的消息。",
      };
    case ResumeActionTypes.InspectInterruption:
      return {
        type: action.type,
        task_id: action.taskId,
        instruction: "检查中断执行的输入和副作用，再决定后续处理。",
      };
    case ResumeActionTypes.EvaluateOutcome:
      return {
        type: action.type,
        task_id: action.taskId,
        instruction: "检查已提交的 Task outcome，并决定归档或继续。",
      };
    case ResumeActionTypes.ResolveTermination:
      return {
        type: action.type,
        task_id: action.taskId,
        instruction: "检查 Task 终止原因，并决定是否重新指派。",
      };
  }
}

export function boundedText(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_TEXT_BYTES) return text;
  const excerpt = Buffer.from(text, "utf8").subarray(0, MAX_TEXT_BYTES).toString("utf8");
  return {
    excerpt,
    truncated: true,
    byte_count: bytes,
  };
}

import type {
  AgentJsonValue,
} from "../tools/types.js";
import type {
  DynamicToolSpec,
  ThreadResumeRequest,
  ThreadStartRequest,
} from "../../agent-server/codex/app-server-client.js";
import type { CodexModelConfig } from "../../agent-server/codex/model-config.js";

/** Workflow-declared role identity that can own a Scout thread. */
export type ScoutAgentRole = string;

/** Named permission profile id accepted by Scout Agent threads. */
export type ScoutAgentPermissionProfile = string;

/** Returns the permission profile identity owned by one Workflow role. */
export function scoutAgentPermissionProfile(role: ScoutAgentRole): ScoutAgentPermissionProfile {
  return `scout-${role}`;
}

/** Workflow-declared Phase identity projected into Agent resources. */
export type ScoutAgentPhase = string;

/** Immutable thread-start configuration derived from a prepared role mount. */
export interface AgentThreadSpec {
  role: ScoutAgentRole;
  phases: ScoutAgentPhase[];
  cwd: string;
  approvalPolicy: "never";
  permissionProfile: ScoutAgentPermissionProfile;
  contextBundleId: string;
  model: CodexModelConfig;
  config?: Record<string, AgentJsonValue>;
  baseInstructions?: string;
  developerInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
}

interface AgentThreadSnapshotBase {
  agentId: string;
  role: ScoutAgentRole;
  phases: ScoutAgentPhase[];
  contextBundleId: string;
  threadId: string;
  createdAt: string;
  startInput: ThreadStartRequest;
  startResponse: unknown;
}

/** Snapshot of a thread that distinguishes active from closed lifecycle facts. */
export type AgentThreadSnapshot = AgentThreadSnapshotBase & (
  | {
      status: "active";
      closedAt?: never;
      closeReason?: never;
    }
  | {
      status: "closed";
      closedAt: string;
      closeReason: string;
    }
);

/** Durable resume evidence returned after reattaching a thread rollout. */
export interface AgentThreadResumeRecord {
  agentId: string;
  role: ScoutAgentRole;
  threadId: string;
  resumedAt: string;
  resumeInput: ThreadResumeRequest;
  resumeResponse: unknown;
}

/** Durable replacement fact linking an unrestorable thread to its successor. */
export interface AgentThreadRestartRecord {
  previousThreadId: string;
  reason: string;
  restartedAt: string;
  newThread: AgentThreadSnapshot;
}

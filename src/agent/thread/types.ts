import type {
  AgentJsonValue,
} from "../tools/types.js";
import type {
  DynamicToolSpec,
  ThreadResumeRequest,
  ThreadStartRequest,
} from "../../agent-server/codex/app-server-client.js";
import type { CodexModelConfig } from "../../agent-server/codex/model-config.js";

/** Stable role identifiers used by mounts, threads, and task routing. */
export const ScoutAgentRoles = {
  Coordinator: "coordinator",
  Researcher: "researcher",
  Verifier: "verifier",
  Validator: "validator",
} as const;

/** Union of roles that can own a Scout thread. */
export type ScoutAgentRole = typeof ScoutAgentRoles[keyof typeof ScoutAgentRoles];

/** Stable Codex permission profile identifiers selected by each Scout role. */
export const ScoutAgentPermissionProfiles = {
  Coordinator: "scout-coordinator",
  Researcher: "scout-researcher",
  Verifier: "scout-verifier",
  Validator: "scout-validator",
} as const;

/** Named permission profile id accepted by Scout Agent threads. */
export type ScoutAgentPermissionProfile = typeof ScoutAgentPermissionProfiles[
  keyof typeof ScoutAgentPermissionProfiles
];

/** Lifecycle phase assigned to a role's tools and Skills. */
export const ScoutAgentPhases = {
  Coordinate: "coordinate",
  Research: "research",
  Verify: "verify",
  Validate: "validate",
} as const;

/** Union of phases recognized by agent tool authorization. */
export type ScoutAgentPhase = typeof ScoutAgentPhases[keyof typeof ScoutAgentPhases];

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

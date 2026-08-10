import type {
  AgentDynamicToolSpec,
  AgentJsonValue,
} from "../tools/types.js";
import type {
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
  sandbox: "read-only" | "workspace-write";
  contextBundleId: string;
  model: CodexModelConfig;
  config?: Record<string, AgentJsonValue>;
  baseInstructions?: string;
  developerInstructions?: string;
  dynamicTools?: AgentDynamicToolSpec[];
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

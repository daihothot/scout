import type { PermissionRequest } from "../../../core/authorization/request/permission/permission-request.js";
import type { ScoutRequestRecord } from "../../../core/authorization/record/authorization-record.js";

/** A read target keeps its owning Workflow identity, not its mutable directory name. */
export interface AgentPermissionTarget {
  readonly workflowId: string;
  readonly agentId: string;
  readonly path: string;
}

/** The business grant is independent of any single native Turn. */
export interface AgentPermissionScope {
  readonly workflowId: string;
  readonly agentId: string;
  readonly phases: readonly string[];
  readonly access: "read";
}

/** Trusted delivery provenance does not restrict later consumption to the producer's Turn. */
export interface AgentPermissionRequest extends PermissionRequest {
  readonly type: "agent.permission.read";
  readonly origin: {
    readonly runId: string;
    readonly agentId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly namespace: string | null;
    readonly tool: string;
    readonly callId: string;
  };
  readonly allowedGrants: readonly {
    readonly scope: AgentPermissionScope;
    readonly target: AgentPermissionTarget;
  }[];
}

/** The actual native caller is recorded anew for every approval. */
export interface AgentPermissionConsumer {
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly phase: string;
  readonly cwd: string;
  readonly environmentId: "local";
}

/** Concrete stored request data; projection creates a separate runtime request. */
export interface AgentPermissionRequestRecord extends ScoutRequestRecord {
  readonly type: "agent.permission.read";
  readonly origin: {
    readonly runId: string;
    readonly agentId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly namespace: string | null;
    readonly tool: string;
    readonly callId: string;
  };
  readonly allowedGrants: readonly { readonly scope: AgentPermissionScope; readonly target: AgentPermissionTarget }[];
}

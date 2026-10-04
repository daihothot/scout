import type { PermissionRequest } from "./permission-request.js";
import type { ScoutRequestRecord } from "../../record/authorization-record.js";
import type { ScoutArtifactReference } from "../../../io/index.js";

/** A read target keeps its owning Workflow identity, not its mutable directory name. */
export interface AgentPermissionTarget extends ScoutArtifactReference {}

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

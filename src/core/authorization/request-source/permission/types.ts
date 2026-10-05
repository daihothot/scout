import type { ScoutRequestSource } from "../types.js";
import type { ScoutRequestSourceRecord } from "../../record/authorization-record.js";
import type { ScoutArtifactReference } from "../../../io/index.js";
import type { ScoutRequest } from "../../types.js";

/** A read target keeps its owning Workflow identity, not its mutable directory name. */
export interface AgentPermissionTarget extends ScoutArtifactReference {}

/** Access instructions derived anew from an active registered request, not a native grant. */
export interface AgentArtifactReadRequest {
  readonly request_id: string;
  readonly read_path: string;
  readonly artifact_ref: string;
}

/** The business grant is independent of any single native Turn. */
export interface AgentPermissionScope {
  readonly workflowId: string;
  readonly agentId: string;
  readonly phases: readonly string[];
  readonly access: "read";
}

/** Current application; its literal native target is matched against stable registered ranges. */
export interface AgentPermissionRequest extends ScoutRequest<{
  readonly workflowId: string; readonly agentId: string; readonly phase: string; readonly access: "read";
}, { readonly path: string }> {}

export type AgentPermissionOrigin =
  | { readonly kind: "workflow"; readonly runId: string; readonly agentId: string }
  | { readonly kind: "tool"; readonly runId: string; readonly agentId: string;
      readonly threadId: string; readonly turnId: string; readonly namespace: string | null;
      readonly tool: string; readonly callId: string };

/** Trusted delivery provenance does not restrict later consumption to the producer's Turn. */
export interface AgentPermissionRequestSource extends ScoutRequestSource {
  readonly type: "agent.permission.read";
  readonly origin: AgentPermissionOrigin;
  readonly allowedGrants: readonly {
    readonly scope: AgentPermissionScope;
    readonly target: AgentPermissionTarget;
  }[];
}

/** Concrete stored source data; projection creates a separate runtime source. */
export interface AgentPermissionRequestSourceRecord extends ScoutRequestSourceRecord {
  readonly type: "agent.permission.read";
  readonly origin: AgentPermissionOrigin;
  readonly allowedGrants: readonly { readonly scope: AgentPermissionScope; readonly target: AgentPermissionTarget }[];
}

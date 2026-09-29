import type { PermissionRequest } from "../../../core/requeshub/permission/permission-request.js";

/** Host-established tool delivery context; none of these identities comes from tool arguments. */
export interface AgentPermissionRequest extends PermissionRequest {
  readonly runId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly environmentId: "local";
  readonly scope: "turn";
  readonly producer: {
    readonly namespace: string | null;
    readonly tool: string;
    readonly callId: string;
  };
}

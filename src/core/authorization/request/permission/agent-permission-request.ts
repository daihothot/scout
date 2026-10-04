import type { DynamicToolCallInput } from "../../../../agent-server/types.js";
import { resolveArtifactTarget } from "../../../io/index.js";
import { currentRunScope } from "../../../../run/run-scope.js";
import type { ScoutRequestRecord } from "../../record/authorization-record.js";
import type { RequestType } from "../types.js";
import { registerPermissionRequest } from "./permission-request.js";
import type { AgentPermissionRequest, AgentPermissionRequestRecord, AgentPermissionTarget } from "./types.js";

/** Decode only persisted Agent-specific fields; live typed registration does not revalidate its own shape. */
export const agentPermissionRequestType: RequestType<AgentPermissionRequest, AgentPermissionRequestRecord> = Object.freeze({
  name: "agent.permission.read",
  encode(value: AgentPermissionRequest): AgentPermissionRequestRecord {
    return { requestId: value.requestId, type: value.type, workflowId: value.workflowId, createdAt: value.createdAt,
      maxConsumptions: value.maxConsumptions, state: { status: "active" },
      origin: structuredClone(value.origin), allowedGrants: structuredClone(value.allowedGrants) };
  },
  project(value: AgentPermissionRequestRecord): AgentPermissionRequest { return structuredClone(value); },
  decode(value: ScoutRequestRecord): AgentPermissionRequestRecord {
    if (!("origin" in value) || !value.origin || typeof value.origin !== "object" || Array.isArray(value.origin)) {
      throw new Error("Invalid stored Agent permission origin.");
    }
    const origin = value.origin;
    if (!("runId" in origin) || typeof origin.runId !== "string"
      || !("agentId" in origin) || typeof origin.agentId !== "string"
      || !("threadId" in origin) || typeof origin.threadId !== "string"
      || !("turnId" in origin) || typeof origin.turnId !== "string"
      || !("namespace" in origin) || (origin.namespace !== null && typeof origin.namespace !== "string")
      || !("tool" in origin) || typeof origin.tool !== "string"
      || !("callId" in origin) || typeof origin.callId !== "string") {
      throw new Error("Invalid stored Agent permission origin.");
    }
    const allowedGrants = value.allowedGrants.map(({ scope, target }) => {
      if (!("workflowId" in scope) || typeof scope.workflowId !== "string" || scope.workflowId !== value.workflowId
        || !("agentId" in scope) || typeof scope.agentId !== "string"
        || !("phases" in scope) || !Array.isArray(scope.phases) || !scope.phases.every((phase) => typeof phase === "string")
        || !("access" in scope) || scope.access !== "read"
        || !("workflowId" in target) || typeof target.workflowId !== "string"
        || !("agentId" in target) || typeof target.agentId !== "string" || !/^[A-Za-z0-9_-]+$/.test(target.agentId)
        || !("path" in target) || typeof target.path !== "string") {
        throw new Error("Invalid stored Agent permission grant.");
      }
      return {
        scope: { workflowId: scope.workflowId, agentId: scope.agentId, phases: [...scope.phases], access: "read" as const },
        target: { workflowId: target.workflowId, agentId: target.agentId, path: target.path },
      };
    });
    return {
      ...value, type: "agent.permission.read", allowedGrants,
      origin: { runId: origin.runId, agentId: origin.agentId, threadId: origin.threadId, turnId: origin.turnId,
        namespace: origin.namespace, tool: origin.tool, callId: origin.callId },
    };
  },
});

/** Called by a successful host tool, not by an Agent-facing grant tool or the RPC router. */
export async function registerAgentPermissionRequest(
  delivery: DynamicToolCallInput,
  input: {
    readonly target: AgentPermissionTarget;
    readonly allowedConsumers: readonly { readonly agentId: string; readonly phases: readonly string[] }[];
    readonly maxConsumptions: number;
  },
): Promise<{ path: string; requestId: string }> {
  const scope = currentRunScope();
  const workflow = scope.workflow.snapshot();
  if (!workflow || workflow.status !== "active") throw new Error("Permission registration requires an active Workflow.");
  const caller = scope.agentRegistry.resolveToolCaller(delivery.threadId);
  if (!caller) throw new Error(`Unknown permission request producer: ${delivery.threadId}`);
  caller.assertOwnsActiveTurn(delivery);
  const resolved = resolveArtifactTarget(input.target);
  if ("reason" in resolved) throw new Error(resolved.reason);
  const path = resolved.path;
  const request = await registerPermissionRequest(scope.authorization, agentPermissionRequestType, {
    maxConsumptions: input.maxConsumptions,
    origin: { runId: scope.runId, agentId: caller.agentId, threadId: delivery.threadId, turnId: delivery.turnId,
      namespace: delivery.namespace, tool: delivery.tool, callId: delivery.callId },
    allowedGrants: input.allowedConsumers.map((consumer) => ({
      scope: { workflowId: workflow.workflowId, agentId: consumer.agentId, phases: consumer.phases, access: "read" },
      target: input.target,
    })),
  });
  return { path, requestId: request.requestId };
}

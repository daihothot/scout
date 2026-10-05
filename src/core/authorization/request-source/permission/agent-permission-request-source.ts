import type { DynamicToolCallInput } from "../../../../agent-server/types.js";
import { resolveArtifactTarget, resolveArtifactReadTarget, parseArtifactReference, readArtifactReference, formatArtifactReference, isArtifactTargetWithin } from "../../../io/index.js";
import { currentRunScope } from "../../../../run/run-scope.js";
import type { ScoutRequestSourceRecord } from "../../record/authorization-record.js";
import type { RequestSourceType } from "../types.js";
import type { AgentArtifactReadRequest, AgentPermissionRequest, AgentPermissionOrigin, AgentPermissionRequestSource, AgentPermissionRequestSourceRecord, AgentPermissionTarget } from "./types.js";

/** Concrete source codec and policy; source lookup remains below the native Backend. */
export const agentPermissionRequestSourceType: RequestSourceType<AgentPermissionRequestSource, AgentPermissionRequestSourceRecord, AgentPermissionRequest> = Object.freeze({
  name: "agent.permission.read",
  encode(value: AgentPermissionRequestSource): AgentPermissionRequestSourceRecord {
    return { sourceId: value.sourceId, sourceKey: value.sourceKey, type: value.type,
      workflowId: value.workflowId, createdAt: value.createdAt,
      maxApprovals: value.maxApprovals, state: { status: "active" },
      origin: structuredClone(value.origin), allowedGrants: structuredClone(value.allowedGrants) };
  },
  project(value: AgentPermissionRequestSourceRecord): AgentPermissionRequestSource { return structuredClone(value); },
  decodeGrant(value: { scope: object; target: object }) {
    const { scope, target } = value;
    if (!("workflowId" in scope) || typeof scope.workflowId !== "string"
      || !("agentId" in scope) || typeof scope.agentId !== "string"
      || !("phases" in scope) || !Array.isArray(scope.phases) || !scope.phases.length
      || !scope.phases.every((phase) => typeof phase === "string")
      || !("access" in scope) || scope.access !== "read") throw new Error("Invalid stored Agent permission grant.");
    return { scope: { workflowId: scope.workflowId, agentId: scope.agentId, phases: [...scope.phases], access: "read" as const },
      target: readArtifactReference(target) };
  },
  decode(value: ScoutRequestSourceRecord): AgentPermissionRequestSourceRecord {
    parseArtifactReference(value.sourceKey);
    if (!("origin" in value) || !value.origin || typeof value.origin !== "object" || Array.isArray(value.origin)) {
      throw new Error("Invalid stored Agent permission origin.");
    }
    const origin = value.origin;
    if (!("runId" in origin) || typeof origin.runId !== "string" || !("agentId" in origin) || typeof origin.agentId !== "string"
      || !("kind" in origin)) throw new Error("Invalid stored Agent permission origin.");
    let decodedOrigin: AgentPermissionOrigin;
    if (origin.kind === "workflow") decodedOrigin = { kind: "workflow", runId: origin.runId, agentId: origin.agentId };
    else if (origin.kind === "tool" && "threadId" in origin && typeof origin.threadId === "string"
      && "turnId" in origin && typeof origin.turnId === "string"
      && "namespace" in origin && (origin.namespace === null || typeof origin.namespace === "string")
      && "tool" in origin && typeof origin.tool === "string" && "callId" in origin && typeof origin.callId === "string") {
      decodedOrigin = { kind: "tool", runId: origin.runId, agentId: origin.agentId,
        threadId: origin.threadId, turnId: origin.turnId, namespace: origin.namespace, tool: origin.tool, callId: origin.callId };
    } else throw new Error("Invalid stored Agent permission origin.");
    const allowedGrants = value.allowedGrants.map((grant) => this.decodeGrant(grant));
    if (allowedGrants.some(({ scope }) => scope.workflowId !== value.workflowId)) throw new Error("Invalid stored permission Workflow.");
    return { ...value, type: "agent.permission.read", allowedGrants, origin: decodedOrigin };
  },
  match(source: AgentPermissionRequestSource, request: AgentPermissionRequest) {
    for (const allowed of source.allowedGrants) {
      if (allowed.scope.workflowId !== request.workflowId || allowed.scope.agentId !== request.scope.agentId
        || !allowed.scope.phases.includes(request.scope.phase)) continue;
      const resolved = resolveArtifactReadTarget(allowed.target, request.target.path);
      if ("reason" in resolved) continue;
      return { scope: { workflowId: request.workflowId, agentId: request.scope.agentId,
        phases: [request.scope.phase], access: "read" as const }, target: resolved.target };
    }
    return undefined;
  },
  covers(source: AgentPermissionRequestSource, grant: AgentPermissionRequestSource["allowedGrants"][number]) {
    return source.allowedGrants.some((allowed) => allowed.scope.workflowId === grant.scope.workflowId
      && allowed.scope.agentId === grant.scope.agentId && allowed.scope.access === grant.scope.access
      && grant.scope.phases.every((phase) => allowed.scope.phases.includes(phase))
      && isArtifactTargetWithin(allowed.target, grant.target));
  },
});

/** Called by a successful host tool, not by an Agent-facing grant tool or the RPC router. */
export async function registerAgentPermissionRequestSource(
  delivery: DynamicToolCallInput,
  input: {
    readonly sourceKey: string;
    readonly target: AgentPermissionTarget;
    readonly allowedConsumers: readonly { readonly agentId: string; readonly phases: readonly string[] }[];
    readonly maxApprovals: number | null;
  },
): Promise<{ path: string; sourceId: string }> {
  const scope = currentRunScope();
  const workflow = scope.workflow.snapshot();
  if (!workflow || workflow.status !== "active") throw new Error("Permission registration requires an active Workflow.");
  const caller = scope.agentRegistry.resolveToolCaller(delivery.threadId);
  if (!caller) throw new Error(`Unknown permission request producer: ${delivery.threadId}`);
  caller.assertOwnsActiveTurn(delivery);
  const resolved = resolveArtifactTarget(input.target);
  if ("reason" in resolved) throw new Error(resolved.reason);
  const path = resolved.path;
  const request = await scope.authorization.register(agentPermissionRequestSourceType, {
    sourceKey: input.sourceKey,
    maxApprovals: input.maxApprovals,
    origin: { kind: "tool", runId: scope.runId, agentId: caller.agentId, threadId: delivery.threadId, turnId: delivery.turnId,
      namespace: delivery.namespace, tool: delivery.tool, callId: delivery.callId },
    allowedGrants: input.allowedConsumers.map((consumer) => ({
      scope: { workflowId: workflow.workflowId, agentId: consumer.agentId, phases: consumer.phases, access: "read" },
      target: input.target,
    })),
  });
  return { path, sourceId: request.sourceId };
}

/** Supplies this consumer's current access instructions without approving or consuming the request. */
export function agentArtifactReadRequests(agentId: string, phase: string): AgentArtifactReadRequest[] {
  const scope = currentRunScope();
  const workflow = scope.workflow.snapshot();
  if (!workflow || workflow.status !== "active") return [];
  const accesses: AgentArtifactReadRequest[] = [];
  for (const request of scope.authorization.sources(agentPermissionRequestSourceType)) {
    if (request.state.status !== "active" || request.workflowId !== workflow.workflowId) continue;
    for (const { scope: allowed, target } of request.allowedGrants) {
      if (allowed.agentId !== agentId || !allowed.phases.includes(phase)) continue;
      const location = resolveArtifactTarget(target);
      if ("reason" in location) continue;
      accesses.push({ request_id: request.sourceId, read_path: location.path,
        artifact_ref: formatArtifactReference(target) });
    }
  }
  return accesses;
}

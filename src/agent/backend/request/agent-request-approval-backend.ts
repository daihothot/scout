import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AppServerRequestController, DynamicToolCallInput, JsonRpcServerRequest,
} from "../../../agent-server/codex/app-server-client.js";
import { registerPermissionRequest } from "../../../core/authorization/request/permission/permission-request.js";
import type { RequestType } from "../../../core/authorization/request/types.js";
import type { ScoutRequestRecord } from "../../../core/authorization/record/authorization-record.js";
import { workflowAgentPaths } from "../../../core/path.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type { AgentPermissionConsumer, AgentPermissionRequest, AgentPermissionRequestRecord, AgentPermissionTarget } from "./types.js";

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
  const resolved = resolveReadTarget(input.target);
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

/** Checks the actual native consumer, then adapts the same approved grant regardless of decision provenance. */
export class AgentRequestApprovalBackend {
  private readonly scope = currentRunScope();

  async handle(request: JsonRpcServerRequest, controller: AppServerRequestController): Promise<void> {
    const scope = this.scope;
    const correlation: {
      rpcId: string | number;
      requestId?: string;
      threadId?: string;
      turnId?: string;
      itemId?: string;
    } = { rpcId: request.id };
    let agentId: string | undefined;
    let approved: Awaited<ReturnType<typeof approveRegisteredRequest>> = undefined;

    try {
      const input = parseReadRequest();
      approved = input ? await approveRegisteredRequest(input) : undefined;
    } catch (error) {
      scope.logger.error({ module: "agent.permission", event: "request_failed", agentId,
        message: error instanceof Error ? error.stack ?? error.message : String(error), data: correlation });
    }

    // The business grant is durable; the provider grant belongs only to this native Turn.
    controller.sendResult(approved === undefined
      ? { permissions: {}, scope: "turn" }
      : { permissions: { fileSystem: { entries: [
        { path: { type: "path", path: approved.path }, access: approved.result.scope.access },
      ] } }, scope: "turn" });

    // Expected refusals neither throw nor consume the registered request's approval allowance.
    function deny(message: string): undefined {
      scope.logger.warn({ module: "agent.permission", event: "request_denied", agentId, message, data: correlation });
      return undefined;
    }

    // Decode only the supported read-only RPC shape; no registry or Agent state here.
    function parseReadRequest() {
      const params = request.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) return deny("Invalid permission RPC parameters.");
      if ("threadId" in params && typeof params.threadId === "string") correlation.threadId = params.threadId;
      if ("turnId" in params && typeof params.turnId === "string") correlation.turnId = params.turnId;
      if ("itemId" in params && typeof params.itemId === "string") correlation.itemId = params.itemId;
      if (!("reason" in params) || typeof params.reason !== "string") return deny("Missing request marker.");
      const marker = /^scout-request-id:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(params.reason);
      if (!marker) return deny("Invalid request marker.");
      const requestId = marker[1]!;
      correlation.requestId = requestId;
      if (!("threadId" in params) || typeof params.threadId !== "string"
        || !("turnId" in params) || typeof params.turnId !== "string"
        || !("itemId" in params) || typeof params.itemId !== "string" || !params.itemId
        || !("environmentId" in params) || typeof params.environmentId !== "string"
        || !("cwd" in params) || typeof params.cwd !== "string") {
        return deny("Invalid permission request context.");
      }
      if (!("permissions" in params) || !params.permissions || typeof params.permissions !== "object") {
        return deny("Missing requested permissions.");
      }
      const permissions = params.permissions;
      if ("network" in permissions && permissions.network != null) {
        const network = permissions.network;
        if (typeof network !== "object" || !("enabled" in network)
          || (network.enabled !== false && network.enabled !== null)) return deny("Network access was not registered.");
      }
      if (!("fileSystem" in permissions) || !permissions.fileSystem || typeof permissions.fileSystem !== "object") {
        return deny("Missing filesystem permission.");
      }
      const fileSystem = permissions.fileSystem;
      if (!("entries" in fileSystem) || !Array.isArray(fileSystem.entries) || fileSystem.entries.length !== 1) {
        return deny("Exactly one literal read target is required.");
      }
      const entry: unknown = fileSystem.entries[0];
      if (!entry || typeof entry !== "object" || !("access" in entry) || entry.access !== "read"
        || !("path" in entry) || !entry.path || typeof entry.path !== "object"
        || !("type" in entry.path) || entry.path.type !== "path"
        || !("path" in entry.path) || typeof entry.path.path !== "string") {
        return deny("Exactly one literal read target is required.");
      }
      const path = entry.path.path;
      // Mirror fields accompanying entries must not introduce additional rights
      // or serve as a fallback for entries.
      if (("write" in fileSystem && fileSystem.write != null
        && (!Array.isArray(fileSystem.write) || fileSystem.write.length !== 0))
        || ("globScanMaxDepth" in fileSystem && fileSystem.globScanMaxDepth != null)
        || ("read" in fileSystem && fileSystem.read != null
          && (!Array.isArray(fileSystem.read) || fileSystem.read.length !== 1 || fileSystem.read[0] !== path))) {
        return deny("Additional filesystem permissions were not registered.");
      }
      return { requestId, threadId: params.threadId, turnId: params.turnId, itemId: params.itemId,
        cwd: params.cwd, environmentId: params.environmentId, path };
    }

    // Match the decoded request to trusted registration and current runtime facts.
    async function approveRegisteredRequest(input: NonNullable<ReturnType<typeof parseReadRequest>>) {
      const registered = scope.authorization.get(agentPermissionRequestType, input.requestId);
      if (!registered || registered.state.status !== "active") return deny("No active permission request.");
      const caller = scope.agentRegistry.resolveAgentByThreadId(input.threadId);
      if (!caller) return deny("Unknown permission request caller.");
      agentId = caller.agentId;
      if (input.environmentId !== "local") return deny("Permission request context mismatch.");
      let cwd: string;
      try {
        cwd = realpathSync(input.cwd);
        if (cwd !== realpathSync(caller.spec.cwd)) return deny("Permission request context mismatch.");
      } catch { return deny("Permission request cwd is unavailable."); }
      const hasCurrentTurn = (): boolean => {
        try { caller.assertOwnsActiveTurn(input); }
        catch (error) { deny(error instanceof Error ? error.message : String(error)); return false; }
        const turn = scope.appServer.turnSnapshot(input.threadId, input.turnId);
        if (turn?.completedAt || (turn?.status && turn.status !== "inProgress")) {
          deny("Permission request Turn has ended.");
          return false;
        }
        return true;
      };
      if (!hasCurrentTurn()) return undefined;
      const workflow = scope.workflow.snapshot();
      if (!workflow || workflow.status !== "active" || registered.workflowId !== workflow.workflowId) {
        return deny("Permission request Workflow is not active.");
      }
      const phase = scope.workflow.graph.snapshot().currentPhase;
      let grant: AgentPermissionRequest["allowedGrants"][number] | undefined;
      let path: string | undefined;
      for (const candidate of registered.allowedGrants) {
        const allowed = candidate.scope;
        if (allowed.workflowId !== workflow.workflowId || allowed.agentId !== caller.agentId || !allowed.phases.includes(phase)) continue;
        const resolved = resolveReadTarget(candidate.target);
        if ("reason" in resolved) continue;
        if (resolved.path === input.path) { grant = candidate; path = resolved.path; break; }
      }
      if (!grant || path === undefined) return deny("No matching registered read target for this Agent and Phase.");
      const consumer: AgentPermissionConsumer = { agentId: caller.agentId, threadId: input.threadId, turnId: input.turnId,
        itemId: input.itemId, phase, cwd, environmentId: "local" };
      const result = await scope.authorization.submit(registered, {
        result: { decision: "approved", scope: grant.scope, target: grant.target }, consumer,
      });
      if (result.decision === "denied") return deny(result.reason);
      // A user can interrupt the Turn while the authorization fact is being committed.
      // Durable business rights never restore or extend an ended native Turn.
      if (!hasCurrentTurn()) return undefined;
      const currentWorkflow = scope.workflow.snapshot();
      if (!currentWorkflow || currentWorkflow.status !== "active" || currentWorkflow.workflowId !== registered.workflowId
        || !result.scope.phases.includes(scope.workflow.graph.snapshot().currentPhase)) {
        return deny("Permission request Workflow or Phase changed during approval.");
      }
      return { result, path };

    }
  }
}

/** Registration and consumption resolve the same stable target against current physical evidence. */
function resolveReadTarget(target: AgentPermissionTarget): { path: string } | { reason: string } {
  const location = currentRunScope().workflow.benchmarks.resolve({ workflowId: target.workflowId });
  if (!location) return { reason: `Permission target Workflow is unavailable: ${target.workflowId}` };
  // Identity corruption and duplicate identities from benchmarks are system errors, not refusals.
  try {
    const workflowRoot = realpathSync(location.workflowRoot);
    const artifactRoot = resolve(workflowAgentPaths(workflowRoot, target.agentId).artifactRoot);
    const ownerPath = relative(join(workflowRoot, "agents"), artifactRoot);
    if (isAbsolute(ownerPath) || ownerPath.split(sep).length !== 2 || ownerPath.split(sep)[0] === "..") {
      return { reason: "Permission target escapes its Agent artifact owner." };
    }
    if (isAbsolute(target.path)) return { reason: "Permission target path must be relative to Agent artifacts." };
    const path = resolve(artifactRoot, target.path);
    const contained = relative(artifactRoot, path);
    if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
      return { reason: "Permission target escapes Agent artifacts." };
    }
    let cursor = workflowRoot;
    for (const part of relative(workflowRoot, path).split(sep)) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) return { reason: "Permission target cannot traverse a symbolic link." };
    }
    const stats = lstatSync(path);
    if (!stats.isFile() && !stats.isDirectory()) return { reason: "Permission target must be a file or directory." };
    return { path: realpathSync(path) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { reason: "Permission target is unavailable." };
    }
    throw error;
  }
}

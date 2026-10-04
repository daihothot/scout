import { realpathSync } from "node:fs";
import type {
  AppServerRequestController, JsonRpcServerRequest,
} from "../../../agent-server/codex/app-server-client.js";
import { agentPermissionRequestType } from "../../../core/authorization/request/permission/agent-permission-request.js";
import { resolveArtifactTarget } from "../../../core/io/index.js";
import type { AgentPermissionRequest } from "../../../core/authorization/request/permission/types.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type { AgentPermissionConsumer } from "./types.js";

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
        const resolved = resolveArtifactTarget(candidate.target);
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

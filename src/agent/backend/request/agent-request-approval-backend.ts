import { realpathSync } from "node:fs";
import type {
  AppServerRequestController, JsonRpcServerRequest,
} from "../../../agent-server/codex/app-server-client.js";
import { agentPermissionRequestSourceType } from "../../../core/authorization/request-source/permission/agent-permission-request-source.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type { AgentPermissionConsumer } from "./types.js";

/** Checks the actual native consumer, then adapts the same approved grant regardless of decision provenance. */
export class AgentRequestApprovalBackend {
  private readonly scope = currentRunScope();

  async handle(request: JsonRpcServerRequest, controller: AppServerRequestController): Promise<void> {
    const scope = this.scope;
    const correlation: {
      rpcId: string | number;
      threadId?: string;
      turnId?: string;
      itemId?: string;
    } = { rpcId: request.id };
    let agentId: string | undefined;
    let approved: Awaited<ReturnType<typeof approveApplication>> = undefined;

    try {
      const input = parseReadRequest();
      approved = input ? await approveApplication(input) : undefined;
    } catch (error) {
      scope.logger.error({ module: "agent.permission", event: "request_failed", agentId,
        message: error instanceof Error ? error.stack ?? error.message : String(error), data: correlation });
    }

    // The business grant is durable; the provider grant belongs only to this native Turn.
    controller.sendResult(!approved?.length
      ? { permissions: {}, scope: "turn" }
      : { permissions: { fileSystem: { entries: approved } }, scope: "turn" });

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
      if (!("entries" in fileSystem) || !Array.isArray(fileSystem.entries) || !fileSystem.entries.length) {
        return deny("At least one literal read target is required.");
      }
      const paths: string[] = [];
      const requestedEntries: readonly unknown[] = fileSystem.entries;
      for (const entry of requestedEntries) {
        if (!entry || typeof entry !== "object" || !("access" in entry) || entry.access !== "read"
          || !("path" in entry) || !entry.path || typeof entry.path !== "object"
          || !("type" in entry.path) || entry.path.type !== "path"
          || !("path" in entry.path) || typeof entry.path.path !== "string") {
          return deny("Only literal read targets are supported.");
        }
        paths.push(entry.path.path);
      }
      // Mirror fields accompanying entries must not introduce additional rights
      // or serve as a fallback for entries.
      if (("write" in fileSystem && fileSystem.write != null
        && (!Array.isArray(fileSystem.write) || fileSystem.write.length !== 0))
        || ("globScanMaxDepth" in fileSystem && fileSystem.globScanMaxDepth != null)
        || ("read" in fileSystem && fileSystem.read != null
          && (!Array.isArray(fileSystem.read) || fileSystem.read.length !== paths.length
            || fileSystem.read.some((path: unknown) => typeof path !== "string" || !paths.includes(path))))) {
        return deny("Additional filesystem permissions were not registered.");
      }
      return { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId,
        cwd: params.cwd, environmentId: params.environmentId, paths };
    }

    // Establish the actual native consumer; Authorization owns source matching and decisions.
    async function approveApplication(input: NonNullable<ReturnType<typeof parseReadRequest>>) {
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
      if (!workflow || workflow.status !== "active") {
        return deny("Permission request Workflow is not active.");
      }
      const phase = scope.workflow.graph.snapshot().currentPhase;
      const consumer: AgentPermissionConsumer = { agentId: caller.agentId, threadId: input.threadId, turnId: input.turnId,
        itemId: input.itemId, phase, cwd, environmentId: "local" };
      const entries: { path: { type: "path"; path: string }; access: "read" }[] = [];
      for (const path of input.paths) {
        const result = await scope.authorization.submit(agentPermissionRequestSourceType, {
          workflowId: workflow.workflowId, consumer,
          scope: { workflowId: workflow.workflowId, agentId: caller.agentId, phase, access: "read" },
          target: { path },
        });
        // A user can interrupt the Turn while the authorization fact is being committed.
        // Durable business rights never restore or extend an ended native Turn.
        if (!hasCurrentTurn()) return undefined;
        const currentWorkflow = scope.workflow.snapshot();
        if (!currentWorkflow || currentWorkflow.status !== "active" || currentWorkflow.workflowId !== workflow.workflowId
          || scope.workflow.graph.snapshot().currentPhase !== phase) {
          return deny("Permission request Workflow or Phase changed during approval.");
        }
        if (result.decision === "denied") {
          deny(result.reason);
          continue;
        }
        entries.push({ path: { type: "path", path }, access: result.scope.access });
      }
      return entries;
    }
  }
}

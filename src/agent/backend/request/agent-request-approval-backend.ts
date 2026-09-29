import { realpathSync } from "node:fs";
import type {
  AppServerRequestController, DynamicToolCallInput, JsonRpcServerRequest,
} from "../../../agent-server/codex/app-server-client.js";
import { registerPermissionRequest, type PermissionApprovalResult } from "../../../core/requeshub/permission/permission-request.js";
import type { RequestRegistrationOptions, RequestType } from "../../../core/requeshub/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { AgentEvents } from "../../events/index.js";
import type { AgentTurnCompletedEvent } from "../../thread/turn-events.js";
import type { AgentPermissionRequest } from "./types.js";

/** Shared contract identity for the Agent producer and its approval consumer. */
export const agentPermissionRequestType: RequestType<AgentPermissionRequest, PermissionApprovalResult> = Object.freeze({
  name: "agent.permission.read",
  isPayload(value: object): value is AgentPermissionRequest {
    if (!("access" in value) || value.access !== "read"
      || !("path" in value) || typeof value.path !== "string"
      || !("runId" in value) || typeof value.runId !== "string"
      || !("agentId" in value) || typeof value.agentId !== "string"
      || !("threadId" in value) || typeof value.threadId !== "string"
      || !("turnId" in value) || typeof value.turnId !== "string"
      || !("cwd" in value) || typeof value.cwd !== "string"
      || !("environmentId" in value) || value.environmentId !== "local"
      || !("scope" in value) || value.scope !== "turn"
      || !("producer" in value) || !value.producer || typeof value.producer !== "object") return false;
    const producer = value.producer;
    return "namespace" in producer && (producer.namespace === null || typeof producer.namespace === "string")
      && "tool" in producer && typeof producer.tool === "string" && producer.tool.length > 0
      && "callId" in producer && typeof producer.callId === "string" && producer.callId.length > 0;
  },
  isResult(value: object): value is PermissionApprovalResult {
    return "decision" in value && (value.decision === "approved"
      || (value.decision === "denied" && "reason" in value && typeof value.reason === "string"));
  },
});

/** Called by a successful host tool, not by an Agent-facing grant tool or the RPC router. */
export function registerAgentPermissionRequest(
  delivery: DynamicToolCallInput,
  path: string,
  options: RequestRegistrationOptions<PermissionApprovalResult> = {},
): { path: string; requestId: string } {
  const scope = currentRunScope();
  const caller = scope.agentRegistry.resolveToolCaller(delivery.threadId);
  if (!caller) throw new Error(`Unknown permission request producer: ${delivery.threadId}`);
  caller.assertOwnsActiveTurn(delivery);
  const hub = scope.requestHub;
  const request = registerPermissionRequest(hub, agentPermissionRequestType, {
    access: "read", path, runId: scope.runId, agentId: caller.agentId,
    threadId: delivery.threadId, turnId: delivery.turnId,
    cwd: realpathSync(caller.spec.cwd), environmentId: "local", scope: "turn",
    producer: { namespace: delivery.namespace, tool: delivery.tool, callId: delivery.callId },
  }, options);
  // The producer binds its request to a lifecycle fact; ScoutAgent and RequestHub
  // do not acquire knowledge of each other's state or responsibilities.
  const unsubscribe = scope.eventBus.subscribe<AgentTurnCompletedEvent>(AgentEvents.turn.completed, ({ payload }) => {
    if (payload.turn.agentId !== request.payload.agentId || payload.turn.threadId !== request.payload.threadId
      || payload.turn.turnId !== request.payload.turnId) return;
    hub.expire(request.requestId, "agent_turn_completed");
    unsubscribe();
  });
  return { path: request.payload.path, requestId: request.requestId };
}

/** Approves only a matching pending host request for the caller's active Turn. */
export class AgentRequestApprovalBackend {
  private readonly scope = currentRunScope();

  handle(request: JsonRpcServerRequest, controller: AppServerRequestController): void {
    const scope = this.scope;
    const correlation: {
      rpcId: string | number;
      requestId?: string;
      threadId?: string;
      turnId?: string;
      itemId?: string;
    } = { rpcId: request.id };
    let agentId: string | undefined;
    let approvedPath: string | undefined;

    try {
      const input = parseReadRequest();
      const approved = input ? approveRegisteredRequest(input) : undefined;
      if (approved) {
        const completion = scope.requestHub.complete(agentPermissionRequestType, approved.requestId, { decision: "approved" });
        void completion.catch((error: unknown) => {
          scope.logger.error({ module: "agent.permission", event: "callback_failed", agentId,
            message: error instanceof Error ? error.stack ?? error.message : String(error), data: correlation });
        });
        approvedPath = approved.payload.path;
      }
    } catch (error) {
      scope.logger.error({ module: "agent.permission", event: "request_failed", agentId,
        message: error instanceof Error ? error.stack ?? error.message : String(error), data: correlation });
    }

    // RPC completion is independent of any optional business callback.
    controller.sendResult(approvedPath === undefined
      ? { permissions: {}, scope: "turn" }
      : { permissions: { fileSystem: { entries: [
        { path: { type: "path", path: approvedPath }, access: "read" },
      ] } }, scope: "turn" });

    // Expected refusals neither throw nor consume the registered request.
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
      return { requestId, threadId: params.threadId, turnId: params.turnId,
        cwd: params.cwd, environmentId: params.environmentId, path };
    }

    // Match the decoded request to trusted registration and current runtime facts.
    function approveRegisteredRequest(input: NonNullable<ReturnType<typeof parseReadRequest>>) {
      const registered = scope.requestHub.get(agentPermissionRequestType, input.requestId);
      if (!registered || registered.status !== "pending") return deny("No pending permission request.");
      const expected = registered.payload;
      agentId = expected.agentId;
      if (input.threadId !== expected.threadId || input.turnId !== expected.turnId
        || input.environmentId !== expected.environmentId || expected.runId !== scope.runId
        || realpathSync(input.cwd) !== expected.cwd) return deny("Permission request context mismatch.");
      const caller = scope.agentRegistry.resolveAgentByThreadId(input.threadId);
      if (!caller || caller.agentId !== expected.agentId || realpathSync(caller.spec.cwd) !== expected.cwd) {
        return deny("Permission request caller mismatch.");
      }
      // This assertion's contract is an expected refusal of stale Agent ownership.
      try { caller.assertOwnsActiveTurn(expected); }
      catch (error) { return deny(error instanceof Error ? error.message : String(error)); }
      const turn = scope.appServer.turnSnapshot(expected.threadId, expected.turnId);
      if (turn?.completedAt || (turn?.status && turn.status !== "inProgress")) {
        return deny("Permission request Turn has ended.");
      }
      if (input.path !== expected.path || realpathSync(expected.path) !== expected.path) {
        return deny("Read target does not match the registered path.");
      }
      return registered;
    }
  }
}

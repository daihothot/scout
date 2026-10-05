import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRequestApprovalBackend } from "../../src/agent/backend/request/agent-request-approval-backend.js";
import {
  agentPermissionRequestSourceType, registerAgentPermissionRequestSource,
} from "../../src/core/authorization/request-source/permission/agent-permission-request-source.js";
import { AgentRequestBackend } from "../../src/agent/backend/request/agent-request-backend.js";
import { RequestSourceHub } from "../../src/core/authorization/request-source/request-source-hub.js";
import type { AgentPermissionTarget } from "../../src/core/authorization/request-source/permission/types.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { AgentTurnCompletedEvent } from "../../src/agent/thread/turn-events.js";
import type { AppServerRequestHandler, CodexAppServerClient, DynamicToolCallInput } from "../../src/agent-server/codex/app-server-client.js";
import type { Logger, LogInput } from "../../src/core/logging/index.js";
import { EventSubscriptionPriorities, type ScoutEvent } from "../../src/core/events/index.js";
import { ApprovalEvents } from "../../src/core/authorization/approval/approval-events.js";
import { workflowAgentPaths, workflowPaths, authorizationJournalPaths } from "../../src/core/io/index.js";
import { Journal } from "../../src/core/journal/index.js";
import { AuthorizationStage } from "../../src/run/lifecycle/stages/authorization-stage.js";
import { createTestGraph, installTestRunScope } from "../helpers/run-persistence.js";

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-permission-unit-")));
  const stage = new AuthorizationStage();
  t.after(() => stage.stop());
  const handlers = new Set<AppServerRequestHandler>();
  const errors: string[] = [];
  const warnings: LogInput[] = [];
  const errorEvents: LogInput[] = [];
  const threads = { executor: "thread-executor", reviewer: "thread-reviewer" };
  const activeTurns = new Map<string, string>([["executor", "execute-turn-1"], ["reviewer", "review-turn-1"]]);
  const completedTurns = new Set<string>();
  const client = {
    onServerRequest(handler: AppServerRequestHandler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
    turnSnapshot: (threadId: string, turnId: string) => completedTurns.has(threadId + ":" + turnId)
      ? { status: "completed" } : undefined,
  } as unknown as CodexAppServerClient;
  const graph = createTestGraph({
    domain: "test", workflowProfile: "permission-test",
    phases: [
      { name: "execute", roles: ["executor"], edges: { completed: "review", error: null } },
      { name: "review", roles: ["reviewer"], edges: { completed: null, error: "execute" } },
    ],
    roles: [
      { name: "coordinator", phases: ["Synthesis"] },
      { name: "executor", phases: ["execute"] },
      { name: "reviewer", phases: ["review"] },
    ],
    currentPhase: "execute",
  });
  const scope = await installTestRunScope(t, {
    runId: "permission-unit", runRoot: join(root, "run", "permission-unit"), scoutRoot: root,
    runtimeGraph: graph, appServer: client, logger: {
      debug() {}, info() {},
      warn(input: LogInput) { warnings.push(input); },
      error(input: LogInput) { errors.push(input.message ?? ""); errorEvents.push(input); },
    } as unknown as Logger,
  });
  await stage.start();
  for (const agentId of ["executor", "reviewer"] as const) {
    const caller = {
      agentId, spec: { cwd: root, phases: agentId === "executor" ? ["execute"] : ["review"] },
      snapshot: () => ({ activeTask: undefined }),
      assertOwnsActiveTurn(input: { threadId: string; turnId: string }) {
        assert.ok(activeTurns.has(agentId), "Agent turn is not active");
        assert.equal(input.threadId, threads[agentId]);
        assert.equal(input.turnId, activeTurns.get(agentId), "Agent owns a different Turn");
      },
    } as unknown as ScoutAgent;
    scope.agentRegistry.registerAgent(caller);
    scope.agentRegistry.bindThread(agentId, threads[agentId]);
  }
  const target = join(scope.workflow.agentPaths("executor").artifactRoot, "execution-pack");
  mkdirSync(target, { recursive: true });
  const targetRef: AgentPermissionTarget = {
    workflowId: scope.workflow.snapshot()!.workflowId, agentId: "executor", internalSymbols: ["execution-pack"],
  };
  const delivery: DynamicToolCallInput = {
    threadId: threads.executor, turnId: "execute-turn-1", callId: "call-1", namespace: "test", tool: "Lookup", arguments: {},
  };
  const register = (maxApprovals = 2, artifactTarget = targetRef, sourceKey = `scout-artifact://${artifactTarget.workflowId}/${artifactTarget.agentId}/${artifactTarget.internalSymbols.join("/")}`) => registerAgentPermissionRequestSource(delivery, {
    sourceKey,
    target: artifactTarget,
    allowedConsumers: [{ agentId: "executor", phases: ["execute"] }, { agentId: "reviewer", phases: ["review"] }],
    maxApprovals,
  });
  const stored = (sourceId: string) => scope.authorization.get(agentPermissionRequestSourceType, sourceId)!;
  const invoke = async (reference: { path: string; sourceId: string }, overrides: Record<string, unknown> = {}) => {
    const responses: unknown[] = [];
    await new AgentRequestApprovalBackend().handle({ id: 1, method: "item/permissions/requestApproval", params: {
      threadId: threads.executor, turnId: activeTurns.get("executor") ?? "execute-turn-1", itemId: "native-item-1", cwd: root,
      environmentId: "local", reason: "scout-request-id:" + reference.sourceId,
      permissions: { fileSystem: { entries: [{ path: { type: "path", path: reference.path }, access: "read" }] } },
      ...overrides,
    } }, { sendResult: (result) => { responses.push(result); }, sendError: () => assert.fail("Expected permission response") });
    assert.equal(responses.length, 1);
    return responses[0];
  };
  const finish = async (agentId: "executor" | "reviewer" = "executor", status: "completed" | "failed" | "interrupted" = "completed") => {
    const turnId = activeTurns.get(agentId)!;
    activeTurns.delete(agentId);
    await scope.eventBus.publishAndWait<AgentTurnCompletedEvent>(AgentEvents.turn.completed, { turn: {
      agentId, role: agentId, invocationId: "invocation-" + agentId, threadId: threads[agentId], turnId,
      status, startedAt: "2026-09-29T00:00:00.000Z", finishedAt: "2026-09-29T00:00:01.000Z",
    } });
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, target, targetRef, scope, delivery, handlers, errors, warnings, errorEvents, register, stored, invoke, finish,
    startTurn(agentId: "executor" | "reviewer", turnId: string) { activeTurns.set(agentId, turnId); },
    endProtocolTurn() { completedTurns.add(threads.executor + ":" + activeTurns.get("executor")); },
    async restore() {
      await stage.stop(); await stage.start();
      scope.authorization.registerRequestSourceType(agentPermissionRequestSourceType);
      scope.authorization.restore(scope.workflow.snapshot()!);
    },
  };
}

const denied = { permissions: {}, scope: "turn" };

test("Permission registration records host origin separately from Workflow grants and current native approval", async (t) => {
  const f = await fixture(t);
  const reference = (await f.register());
  assert.deepEqual(Object.keys(reference).sort(), ["path", "sourceId"]);
  const request = f.stored(reference.sourceId);
  assert.deepEqual(request.origin, {
    kind: "tool", runId: f.scope.runId, agentId: "executor", threadId: "thread-executor", turnId: "execute-turn-1",
    namespace: "test", tool: "Lookup", callId: "call-1",
  });
  assert.equal(request.workflowId, f.targetRef.workflowId);
  assert.equal(request.state.status, "active");
  assert.deepEqual(request.allowedGrants[0], {
    scope: { workflowId: request.workflowId, agentId: "executor", phases: ["execute"], access: "read" },
    target: f.targetRef,
  });
  assert.deepEqual((await f.invoke(reference)), { permissions: { fileSystem: { entries: [
    { path: { type: "path", path: f.target }, access: "read" },
  ] } }, scope: "turn" });
  const approvals = f.scope.authorization.approvals(request);
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0]!.basis, { kind: "new" });
  assert.deepEqual(approvals[0]!.consumer, {
    agentId: "executor", threadId: "thread-executor", turnId: "execute-turn-1",
    itemId: "native-item-1", phase: "execute", cwd: f.root, environmentId: "local",
  });
  assert.equal(f.scope.authorization.credentials(request)[0]?.credentialId, approvals[0]!.approvalId);
  await f.finish();
  assert.equal(f.stored(reference.sourceId).state.status, "active");
});

test("Permission approval rejects forged identity, broader rights, and stale context without consuming allowance", async (t) => {
  const f = await fixture(t);
  const reference = (await f.register());
  const readEntry = { path: { type: "path", path: f.target }, access: "read" };
  for (const overrides of [
    { threadId: "other-thread" }, { turnId: "other-turn" }, { environmentId: "remote" }, { cwd: f.target },
    { permissions: { network: { enabled: true }, fileSystem: { entries: [readEntry] } } },
    { permissions: { fileSystem: { entries: [{ ...readEntry, access: "write" }] } } },
    { permissions: { fileSystem: { entries: [{ path: { type: "path", path: f.root }, access: "read" }] } } },
    { permissions: { fileSystem: { entries: [readEntry, readEntry] } } },
    { permissions: { fileSystem: { read: [f.target] } } },
    { permissions: { fileSystem: { entries: [readEntry], write: [f.target] } } },
    { permissions: { fileSystem: { entries: [readEntry], read: [f.root] } } },
    { permissions: { fileSystem: { entries: [readEntry], globScanMaxDepth: 1 } } },
  ]) {
    assert.deepEqual((await f.invoke(reference, overrides)), denied);
    assert.equal(f.stored(reference.sourceId).state.status, "active");
  }
  f.endProtocolTurn();
  assert.deepEqual((await f.invoke(reference)), denied);
  await f.finish("executor", "interrupted");
  assert.deepEqual((await f.invoke(reference)), denied);
  assert.equal(f.scope.authorization.consumed(f.stored(reference.sourceId)), 0);
  await assert.rejects(async () => (await f.register()), /not active/);
});

test("Native approval uses the application rather than a request-ID marker and can read a contained file", async (t) => {
  const f = await fixture(t);
  const historicalRoot = join(f.scope.runRoot, "workflows", "imported read evidence");
  mkdirSync(workflowAgentPaths(historicalRoot, "executor").artifactRoot, { recursive: true });
  writeFileSync(workflowPaths(historicalRoot).identityPath, JSON.stringify({ workflowId: "workflow-009" }));
  const historicalTarget = { workflowId: "workflow-009", agentId: "executor", internalSymbols: [] };
  const reference = await f.register(2, historicalTarget);
  const child = join(reference.path, "execute-file.json");
  writeFileSync(child, "{}");
  for (const reason of [undefined, "Read this execution artifact", `scout-request-id:${randomUUID()}`]) {
    const result = await f.invoke({ ...reference, path: child }, { reason });
    assert.deepEqual(result, { permissions: { fileSystem: { entries: [
      { path: { type: "path", path: child }, access: "read" },
    ] } }, scope: "turn" });
  }
  const source = f.stored(reference.sourceId);
  assert.equal(f.scope.authorization.consumed(source), 1);
  assert.deepEqual(f.scope.authorization.approvals(source)[0]!.result, { decision: "approved",
    scope: { workflowId: source.workflowId, agentId: "executor", phases: ["execute"], access: "read" },
    target: { ...historicalTarget, internalSymbols: ["execute-file.json"] },
  });
  await f.restore();
  const renamed = join(f.scope.runRoot, "workflows", "renamed permission workflow");
  renameSync(historicalRoot, renamed);
  const renamedChild = join(workflowAgentPaths(renamed, "executor").artifactRoot, "execute-file.json");
  assert.notDeepEqual(await f.invoke({ ...reference, path: renamedChild }, { reason: undefined }), denied);
  assert.equal(f.scope.authorization.consumed(f.stored(reference.sourceId)), 1);
  assert.deepEqual(await f.invoke({ ...reference, path: f.scope.workflow.agentPaths("reviewer").artifactRoot }), denied);
});

test("Credential approval returns the same grant in later Turns and after restoring authorization facts", async (t) => {
  const f = await fixture(t);
  const reference = (await f.register(1));
  const firstResponse = (await f.invoke(reference));
  const firstRequest = f.stored(reference.sourceId);
  const first = f.scope.authorization.approvals(firstRequest)[0]!;
  await f.finish();
  f.startTurn("executor", "execute-turn-2");
  assert.deepEqual((await f.invoke(reference)), firstResponse);
  const second = f.scope.authorization.credentialUses(first.approvalId)[0]!;
  assert.equal(second.credentialId, first.approvalId);
  assert.equal(f.scope.authorization.consumed(firstRequest), 1);
  await f.finish();
  await f.restore();
  f.startTurn("executor", "execute-turn-restored");
  assert.deepEqual((await f.invoke(reference)), firstResponse);
  const restored = f.stored(reference.sourceId);
  const records = f.scope.authorization.approvals(restored);
  assert.deepEqual(records, [first]);
  const uses = f.scope.authorization.credentialUses(first.approvalId);
  assert.equal(uses.length, 2);
  assert.deepEqual(uses[0], second);
  assert.equal(uses[1]!.consumer && "turnId" in uses[1]!.consumer ? uses[1]!.consumer.turnId : undefined, "execute-turn-restored");
  assert.equal(f.scope.authorization.consumed(restored), 1);
  assert.equal(f.scope.authorization.credentials(restored).length, 1);
  assert.equal(restored.origin.kind === "tool" && restored.origin.turnId, "execute-turn-1");
});

test("A new request of the same type can use an existing Workflow grant without consuming its new-approval allowance", async (t) => {
  const f = await fixture(t);
  const source = (await f.register(1));
  const firstResponse = (await f.invoke(source));
  const sourceRequest = f.stored(source.sourceId);
  const issued = f.scope.authorization.approvals(sourceRequest)[0]!;
  await f.scope.authorization.expire(source.sourceId, "replace_source");
  const next = (await f.register(1, f.targetRef, `scout-artifact://${f.targetRef.workflowId}/executor/another-basis`));
  assert.notEqual(next.sourceId, source.sourceId);
  assert.deepEqual((await f.invoke(next)), firstResponse);
  const nextRequest = f.stored(next.sourceId);
  assert.deepEqual(f.scope.authorization.approvals(nextRequest), []);
  assert.equal(f.scope.authorization.credentialUses(issued.approvalId)[0]!.sourceId, nextRequest.sourceId);
  assert.equal(f.scope.authorization.consumed(sourceRequest), 1);
  assert.equal(f.scope.authorization.consumed(nextRequest), 0);
  const credentials = f.scope.authorization.credentials(nextRequest);
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0]!.credentialId, issued.approvalId);
  assert.equal(credentials[0]!.sourceId, source.sourceId, "The signing request remains provenance, not a consumption restriction");
});

test("The same request can issue a separate Reviewer grant but cannot use an Executor credential across Agents", async (t) => {
  const f = await fixture(t);
  const reference = (await f.register());
  assert.notDeepEqual((await f.invoke(reference)), denied);
  await f.finish();
  f.scope.workflow.graph.advance("completed");
  assert.notDeepEqual((await f.invoke(reference, { threadId: "thread-reviewer", turnId: "review-turn-1" })), denied);
  const request = f.stored(reference.sourceId);
  const records = f.scope.authorization.approvals(request);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.basis.kind, "new");
  assert.equal(records[1]!.basis.kind, "new");
  if (records[0]!.result.decision !== "approved" || records[1]!.result.decision !== "approved") assert.fail("Expected grants");
  assert.equal(records[0]!.result.scope.agentId, "executor");
  assert.equal(records[1]!.result.scope.agentId, "reviewer");
  assert.equal(f.scope.authorization.consumed(request), 2);
  assert.equal(f.scope.authorization.credentials(request).length, 2);
  await f.finish("reviewer");
  f.startTurn("reviewer", "review-turn-2");
  assert.notDeepEqual((await f.invoke(reference, { threadId: "thread-reviewer", turnId: "review-turn-2" })), denied);
  assert.equal(f.scope.authorization.approvals(request).length, 2);
  assert.equal(f.scope.authorization.credentialUses(records[1]!.approvalId)[0]!.credentialId, records[1]!.approvalId);
});

test("A spent new-approval allowance denies another Agent but still permits the already issued grant", async (t) => {
  const f = await fixture(t);
  const reference = (await f.register(1));
  const firstResponse = (await f.invoke(reference));
  f.scope.workflow.graph.advance("completed");
  assert.deepEqual((await f.invoke(reference, { threadId: "thread-reviewer", turnId: "review-turn-1" })), denied);
  const request = f.stored(reference.sourceId);
  const records = f.scope.authorization.approvals(request);
  assert.equal(records.length, 2);
  assert.deepEqual(records[1]!.result, { decision: "denied", reason: "Request approval allowance is exhausted." });
  assert.deepEqual(records[1]!.basis, { kind: "denied" });
  assert.equal(f.scope.authorization.consumed(request), 1);
  f.scope.workflow.graph.advance("error");
  assert.deepEqual((await f.invoke(reference)), firstResponse);
  assert.equal(f.scope.authorization.consumed(request), 1);
  assert.equal(f.scope.authorization.credentials(request).length, 1);
});

test("Malformed and unauthorized permission RPCs remain ordinary correlated denials", async (t) => {
  const f = await fixture(t);
  const reference = (await f.register());
  for (const overrides of [
    { permissions: null },
    { permissions: { fileSystem: { entries: null } } },
    { permissions: { fileSystem: { entries: [null] } } },
    { permissions: { fileSystem: { entries: [{ access: "read", path: { type: "glob", path: f.target } }] } } },
    { permissions: { fileSystem: { entries: [{ access: "read", path: { type: "path", path: 123 } }] } } },
    { permissions: { network: { enabled: true } } },
    { threadId: "other-thread" },
  ]) {
    assert.deepEqual((await f.invoke(reference, overrides)), denied);
    const refusal = f.warnings.at(-1)!;
    assert.equal(refusal.event, "request_denied");
    assert.deepEqual(refusal.data, {
      rpcId: 1,
      threadId: overrides.threadId ?? "thread-executor", turnId: "execute-turn-1", itemId: "native-item-1",
    });
  }
  assert.equal(f.errorEvents.length, 0);
  assert.equal(f.scope.authorization.approvals(f.stored(reference.sourceId)).length, 0);
});

test("Matching native mirror fields preserve the exact registered read-only grant", async (t) => {
  const f = await fixture(t);
  for (const [index, network] of [null, { enabled: false }, { enabled: null }].entries()) {
    const reference = (await f.register());
    const entries = [{ path: { type: "path", path: f.target }, access: "read" }];
    assert.deepEqual((await f.invoke(reference, { permissions: {
      network, fileSystem: { entries, read: [f.target], write: [], globScanMaxDepth: null },
    } })), { permissions: { fileSystem: { entries } }, scope: "turn" });
    const request = f.stored(reference.sourceId);
    assert.equal(f.scope.authorization.consumed(request), 1);
    assert.equal(f.scope.authorization.approvals(request).length, 1);
    if (index > 0) assert.ok(f.scope.authorization.credentials(request).length === 1);
  }
  assert.equal(f.warnings.length, 0);
  assert.equal(f.errorEvents.length, 0);
});

for (const operation of ["lookup", "submit"] as const) {
  test("Authorization " + operation + " failure denies access but is logged as an internal error", async (t) => {
    const f = await fixture(t);
    const reference = (await f.register());
    const fault = new Error("Authorization " + operation + " failure");
    const injected = operation === "lookup"
      ? t.mock.method(RequestSourceHub.prototype, "ofType", () => { throw fault; })
      : t.mock.method(f.scope.authorization, "submit", () => { throw fault; });
    assert.deepEqual((await f.invoke(reference)), denied);
    injected.mock.restore();
    assert.equal(f.warnings.length, 0);
    assert.equal(f.errorEvents.length, 1);
    assert.equal(f.errorEvents[0]?.event, "request_failed");
    assert.equal(f.errorEvents[0]?.message, fault.stack);
    assert.deepEqual(f.errorEvents[0]?.data, {
      rpcId: 1, threadId: "thread-executor", turnId: "execute-turn-1", itemId: "native-item-1",
    });
    assert.equal(f.scope.authorization.consumed(f.stored(reference.sourceId)), 0);
    assert.equal(f.scope.authorization.credentials(f.stored(reference.sourceId)).length, 0);
  });
}

test("Lost current Turn ownership is a denial rather than an authorization service fault", async (t) => {
  const f = await fixture(t);
  const reference = (await f.register());
  const caller = f.scope.agentRegistry.resolveAgentByThreadId("thread-executor")!;
  t.mock.method(caller, "assertOwnsActiveTurn", () => { throw new Error("Agent no longer owns this Turn."); });
  assert.deepEqual((await f.invoke(reference)), denied);
  assert.equal(f.warnings[0]?.event, "request_denied");
  assert.match(f.warnings[0]?.message ?? "", /no longer owns/);
  assert.equal(f.errorEvents.length, 0);
  assert.equal(f.scope.authorization.consumed(f.stored(reference.sourceId)), 0);
});

test("Stable read targets reject escaping, absolute, absent, and symbolic-link paths", async (t) => {
  const f = await fixture(t);
  await assert.rejects(async () => (await f.register(1, { ...f.targetRef, internalSymbols: ["..","outside"] })), /escapes Agent artifacts/);
  await assert.rejects(async () => (await f.register(1, { ...f.targetRef, internalSymbols: [f.target] })), /must be relative/);
  await assert.rejects(async () => (await f.register(1, { ...f.targetRef, internalSymbols: ["absent"] })), /unavailable/);
  await assert.rejects(async () => (await f.register(1, { ...f.targetRef, agentId: "../outside" })), /escapes its Agent artifact owner/);
  const alias = join(f.scope.workflow.agentPaths("executor").artifactRoot, "target-link");
  symlinkSync(f.target, alias);
  await assert.rejects(async () => (await f.register(1, { ...f.targetRef, internalSymbols: ["target-link"] })), /symbolic link/);
  const reference = (await f.register());
  rmSync(f.target, { recursive: true });
  symlinkSync(f.root, f.target);
  assert.deepEqual((await f.invoke(reference)), denied);
  assert.equal(f.scope.authorization.consumed(f.stored(reference.sourceId)), 0);
});

test("A historical Workflow target is relocated by identity without changing its registered grant or credential", async (t) => {
  const f = await fixture(t);
  const historicalRoot = join(f.scope.runRoot, "workflows", "imported-history");
  const historicalTarget: AgentPermissionTarget = { workflowId: "workflow-009", agentId: "executor", internalSymbols: ["execution-pack"] };
  const oldPath = join(workflowAgentPaths(historicalRoot, "executor").artifactRoot, historicalTarget.internalSymbols.join("/"));
  mkdirSync(oldPath, { recursive: true });
  writeFileSync(workflowPaths(historicalRoot).identityPath, JSON.stringify({ workflowId: historicalTarget.workflowId }));
  const reference = (await f.register(1, historicalTarget));
  assert.equal(reference.path, realpathSync(oldPath));
  assert.notDeepEqual((await f.invoke(reference)), denied);
  const request = f.stored(reference.sourceId);
  const firstResult = f.scope.authorization.approvals(request)[0]!.result;
  const renamed = join(f.scope.runRoot, "workflows", "renamed-history");
  renameSync(historicalRoot, renamed);
  const path = join(workflowAgentPaths(renamed, "executor").artifactRoot, historicalTarget.internalSymbols.join("/"));
  assert.deepEqual((await f.invoke(reference)), denied);
  assert.notDeepEqual((await f.invoke({ ...reference, path })), denied);
  assert.deepEqual(f.scope.authorization.approvals(request)[0]!.result, firstResult);
  assert.equal(f.scope.authorization.credentialUses(f.scope.authorization.approvals(request)[0]!.approvalId).length, 1);
  assert.equal(f.scope.authorization.consumed(request), 1);
  assert.deepEqual(f.scope.authorization.credentials(request)[0]!.target, historicalTarget);
});

test("A registered Agent/Phase can choose any of its explicit targets, including a later matching grant", async (t) => {
  const f = await fixture(t);
  const original = f.stored((await f.register()).sourceId);
  const secondTarget = { ...f.targetRef, internalSymbols: ["second-pack"] };
  const secondPath = join(f.scope.workflow.agentPaths("executor").artifactRoot, secondTarget.internalSymbols.join("/"));
  mkdirSync(secondPath);
  const request = await f.scope.authorization.register(agentPermissionRequestSourceType, {
    sourceKey: `scout-artifact://${secondTarget.workflowId}/${secondTarget.agentId}/${secondTarget.internalSymbols.join("/")}`,
    origin: original.origin, maxApprovals: 2,
    allowedGrants: [
      original.allowedGrants[0]!,
      { scope: original.allowedGrants[0]!.scope, target: secondTarget },
    ],
  });
  assert.notDeepEqual((await f.invoke({ sourceId: request.sourceId, path: secondPath })), denied);
  const result = f.scope.authorization.approvals(request)[0]!.result;
  if (result.decision !== "approved") assert.fail("Expected the second target to be approved");
  assert.deepEqual(result.target, secondTarget);
  assert.deepEqual(f.scope.authorization.credentials(request)[0]!.target, secondTarget);
});

test("Turn completion retains the request, but Workflow completion expires it and forbids empty-workflow registration", async (t) => {
  const f = await fixture(t);
  const reference = (await f.register());
  f.delivery.turnId = "caller-mutated-delivery";
  await f.finish("executor", "failed");
  assert.equal(f.stored(reference.sourceId).state.status, "active");
  const origin = f.stored(reference.sourceId).origin;
  assert.equal(origin.kind === "tool" && origin.turnId, "execute-turn-1");
  await f.scope.workflow.advance("error");
  assert.equal(f.scope.workflow.snapshot(), undefined);
  assert.equal(f.stored(reference.sourceId), undefined);
  assert.deepEqual((await f.invoke(reference)), denied);
  await assert.rejects(async () => (await f.register()), /requires an active Workflow/);
});

test("Request Backend subscribes once, leaves dynamic tools and native hooks unclaimed, and unsubscribes on stop", async (t) => {
  const f = await fixture(t);
  const backend = new AgentRequestBackend();
  backend.start(); backend.start();
  assert.equal(f.handlers.size, 1);
  const handler = [...f.handlers][0]!;
  for (const method of ["item/tool/call", "item/commandExecution/requestApproval"]) {
    assert.equal(await handler({ id: 1, method }, {
      sendResult: () => assert.fail("Must use the existing dedicated entry"), sendError: () => assert.fail(),
    }), false);
  }
  const responses: unknown[] = [];
  assert.equal(await handler({ id: 2, method: "item/permissions/requestApproval", params: null }, {
    sendResult: (result) => { responses.push(result); }, sendError: () => assert.fail(),
  }), true);
  assert.deepEqual(responses, [denied]);
  backend.stop(); backend.stop();
  assert.equal(f.handlers.size, 0);
});

test("Native approval is returned only after recording and runtime credential application succeed", async (t) => {
  const f = await fixture(t);
  const reference = await f.register();
  const request = f.stored(reference.sourceId);
  const append = Journal.prototype.append;
  let written = false;
  t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
    assert.equal(f.scope.authorization.consumed(request), 0);
    assert.deepEqual(f.scope.authorization.credentials(request), []);
    const recorded = append.call(this, event);
    written = true;
    return recorded;
  });
  assert.notDeepEqual(await f.invoke(reference), denied);
  assert.equal(written, true);
  assert.equal(f.scope.authorization.consumed(request), 1);
  assert.equal(f.scope.authorization.credentials(request).length, 1);
});

test("A failed native approval write denies the RPC without spending quota or issuing a credential", async (t) => {
  const f = await fixture(t);
  const reference = await f.register();
  const request = f.stored(reference.sourceId);
  t.mock.method(Journal.prototype, "append", () => { throw new Error("authorization disk unavailable"); });
  assert.deepEqual(await f.invoke(reference), denied);
  assert.equal(f.scope.authorization.consumed(request), 0);
  assert.deepEqual(f.scope.authorization.credentials(request), []);
  assert.ok(f.errorEvents.some((event) => event.event === "request_failed" && event.message?.includes("authorization disk unavailable")));
});

test("Workflow identity and unexpected filesystem resolution faults are not hidden as unmatched grants", async (t) => {
  const f = await fixture(t);
  const reference = await f.register();
  const workflowsRoot = join(f.scope.runRoot, "workflows");
  const duplicateRoot = join(workflowsRoot, "duplicate identity");
  mkdirSync(duplicateRoot);
  writeFileSync(workflowPaths(duplicateRoot).identityPath, JSON.stringify({ workflowId: "workflow-001" }));
  try {
    assert.deepEqual(await f.invoke(reference), denied);
    assert.match(f.errorEvents.at(-1)?.message ?? "", /Duplicate Workflow identity/);
  } finally { rmSync(duplicateRoot, { recursive: true }); }
  const identityPath = workflowPaths(join(workflowsRoot, "test--workflow-001")).identityPath;
  const identity = readFileSync(identityPath, "utf8");
  writeFileSync(identityPath, "{");
  try {
    assert.deepEqual(await f.invoke(reference), denied);
    assert.match(f.errorEvents.at(-1)?.message ?? "", /SyntaxError/);
  } finally { writeFileSync(identityPath, identity); }
  const movedRoot = join(f.scope.runRoot, "held workflow evidence");
  renameSync(workflowsRoot, movedRoot);
  writeFileSync(workflowsRoot, "not a directory");
  try {
    assert.deepEqual(await f.invoke(reference), denied);
    assert.match(f.errorEvents.at(-1)?.message ?? "", /ENOTDIR/);
  } finally {
    rmSync(workflowsRoot);
    renameSync(movedRoot, workflowsRoot);
  }
  assert.equal(f.warnings.length, 0);
  assert.equal(f.scope.authorization.consumed(f.stored(reference.sourceId)), 0);
});

test("Malformed stored Agent permission scope fails during owner restoration rather than first RPC", async (t) => {
  const f = await fixture(t);
  const reference = await f.register();
  const location = { journalId: `${f.scope.runId}:authorization`, ...authorizationJournalPaths(f.scope.workflow.journalRoot) };
  // Release the currently installed owner before modifying external persisted data.
  const owner = f.scope.authorization;
  owner.stop();
  const journal = Journal.open(location);
  const records = journal.readAll();
  const payload = records[0]!.payload as { source: { allowedGrants: { scope: object }[] } };
  Object.assign(payload.source.allowedGrants[0]!.scope, { phases: "not-an-array" });
  journal.replaceAll(records);
  journal.close();
  await assert.rejects(f.restore(), /Invalid stored Agent permission grant/);
  assert.equal(f.scope.authorization.get(agentPermissionRequestSourceType, reference.sourceId), undefined);
  assert.equal(f.scope.authorization.find(reference.sourceId), undefined);
});

test("A Turn interrupted during durable approval does not receive a restored native grant", async (t) => {
  const f = await fixture(t);
  const reference = await f.register();
  f.scope.eventBus.subscribe(ApprovalEvents.authorizationApproval.submitted, () => f.finish("executor", "interrupted"),
    { priority: EventSubscriptionPriorities.Critical });
  assert.deepEqual(await f.invoke(reference), denied);
  const request = f.stored(reference.sourceId);
  assert.equal(f.scope.authorization.consumed(request), 1, "The committed business approval remains a fact.");
  f.startTurn("executor", "execute-after-interruption");
  assert.notDeepEqual(await f.invoke(reference), denied);
  assert.equal(f.scope.authorization.consumed(request), 1, "A new native Turn can consume the existing business credential.");
});

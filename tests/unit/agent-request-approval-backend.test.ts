import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AgentRequestApprovalBackend, agentPermissionRequestType, registerAgentPermissionRequest,
} from "../../src/agent/backend/request/agent-request-approval-backend.js";
import { AgentRequestBackend } from "../../src/agent/backend/request/agent-request-backend.js";
import type { ScoutAgent } from "../../src/agent/core/scout-agent.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { AgentTurnCompletedEvent } from "../../src/agent/thread/turn-events.js";
import type { AppServerRequestHandler, CodexAppServerClient, DynamicToolCallInput } from "../../src/agent-server/codex/app-server-client.js";
import type { Logger, LogInput } from "../../src/core/logging/index.js";
import { RequestHubStage } from "../../src/run/lifecycle/stages/request-hub-stage.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-permission-unit-")));
  const target = join(root, "target");
  mkdirSync(target);
  const hubStage = new RequestHubStage();
  t.after(async () => { await hubStage.stop(); rmSync(root, { recursive: true, force: true }); });
  const handlers = new Set<AppServerRequestHandler>();
  const errors: string[] = [];
  const warnings: LogInput[] = [];
  const errorEvents: LogInput[] = [];
  let active = true;
  let protocolCompleted = false;
  const client = {
    onServerRequest(handler: AppServerRequestHandler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
    turnSnapshot: () => protocolCompleted ? { status: "completed" } : undefined,
  } as unknown as CodexAppServerClient;
  const scope = await installTestRunScope(t, { runId: "permission-unit", appServer: client, logger: {
    debug() {}, info() {},
    warn(input: LogInput) { warnings.push(input); },
    error(input: LogInput) { errors.push(input.message ?? ""); errorEvents.push(input); },
  } as unknown as Logger });
  await hubStage.start();
  const caller = {
    agentId: "executor", spec: { cwd: root },
    assertOwnsActiveTurn(input: { threadId: string; turnId: string }) {
      assert.equal(active, true, "Agent turn is not active");
      assert.equal(input.threadId, "thread-1");
      assert.equal(input.turnId, "turn-1");
    },
  } as unknown as ScoutAgent;
  scope.agentRegistry.registerAgent(caller);
  scope.agentRegistry.bindThread(caller.agentId, "thread-1");
  const delivery: DynamicToolCallInput = {
    threadId: "thread-1", turnId: "turn-1", callId: "call-1", namespace: "test", tool: "Lookup", arguments: {},
  };
  const invoke = (reference: { path: string; requestId: string }, overrides: Record<string, unknown> = {}) => {
    const responses: unknown[] = [];
    new AgentRequestApprovalBackend().handle({ id: 1, method: "item/permissions/requestApproval", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "native-item-1", cwd: root,
      environmentId: "local", reason: `scout-request-id:${reference.requestId}`,
      permissions: { fileSystem: { entries: [{ path: { type: "path", path: reference.path }, access: "read" }] } },
      ...overrides,
    } }, { sendResult: (result) => { responses.push(result); }, sendError: () => assert.fail("Expected permission response") });
    assert.equal(responses.length, 1);
    return responses[0];
  };
  const finish = async (status: "completed" | "failed" | "interrupted" = "completed") => {
    active = false;
    await scope.eventBus.publishAndWait<AgentTurnCompletedEvent>(AgentEvents.turn.completed, { turn: {
      agentId: "executor", role: "executor", invocationId: "invocation-1", threadId: "thread-1", turnId: "turn-1",
      status, startedAt: "2026-09-29T00:00:00.000Z", finishedAt: "2026-09-29T00:00:01.000Z",
    } });
  };
  return { root, target, scope, delivery, handlers, errors, warnings, errorEvents, invoke, finish,
    endProtocolTurn: () => { protocolCompleted = true; } };
}

test("Permission registration uses host delivery and approval grants only the registered read target", async (t) => {
  const f = await fixture(t);
  let callbacks = 0;
  const reference = registerAgentPermissionRequest(f.delivery, f.target, { callback: (result) => {
    assert.equal(result.decision, "approved"); callbacks += 1;
  } });
  assert.deepEqual(Object.keys(reference).sort(), ["path", "requestId"]);
  const stored = f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)!;
  assert.deepEqual(stored.payload.producer, { namespace: "test", tool: "Lookup", callId: "call-1" });
  assert.deepEqual(f.invoke(reference), { permissions: { fileSystem: { entries: [
    { path: { type: "path", path: f.target }, access: "read" },
  ] } }, scope: "turn" });
  assert.deepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
  await Promise.resolve();
  assert.equal(callbacks, 1);
  await f.finish();
  assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "completed");
});

test("Permission approval rejects forged identity, broader rights, and stale context without consuming a valid request", async (t) => {
  const f = await fixture(t);
  const reference = registerAgentPermissionRequest(f.delivery, f.target);
  const readEntry = { path: { type: "path", path: f.target }, access: "read" };
  for (const overrides of [
    { reason: `scout-request-id:${randomUUID()}` }, { reason: `Please scout-request-id:${reference.requestId}` },
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
    assert.deepEqual(f.invoke(reference, overrides), { permissions: {}, scope: "turn" });
    assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "pending");
  }
  f.endProtocolTurn();
  assert.deepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
  await f.finish("interrupted");
  assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "expired");
  assert.deepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
  assert.throws(() => registerAgentPermissionRequest(f.delivery, f.target), /not active/);
});

test("Permission callback failure does not prevent or duplicate the native approval response", async (t) => {
  const f = await fixture(t);
  const reference = registerAgentPermissionRequest(f.delivery, f.target, { callback: () => { throw new Error("callback failed"); } });
  assert.notDeepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.errors.length, 1);
  assert.equal(f.errorEvents[0]?.event, "callback_failed");
  assert.equal(f.errorEvents[0]?.agentId, "executor");
  assert.deepEqual(f.errorEvents[0]?.data, {
    rpcId: 1, requestId: reference.requestId, threadId: "thread-1", turnId: "turn-1", itemId: "native-item-1",
  });
  assert.equal(f.warnings.length, 0);
  assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "completed");
  await f.finish();
});

test("Malformed and unauthorized permission requests remain ordinary correlated denials", async (t) => {
  const f = await fixture(t);
  let callbacks = 0;
  const reference = registerAgentPermissionRequest(f.delivery, f.target, { callback: () => { callbacks += 1; } });
  for (const overrides of [
    { permissions: null },
    { permissions: { fileSystem: { entries: null } } },
    { permissions: { fileSystem: { entries: [null] } } },
    { permissions: { fileSystem: { entries: [{ access: "read", path: { type: "glob", path: f.target } }] } } },
    { permissions: { fileSystem: { entries: [{ access: "read", path: { type: "path", path: 123 } }] } } },
    { permissions: { network: { enabled: true } } },
    { threadId: "other-thread" },
  ]) {
    assert.deepEqual(f.invoke(reference, overrides), { permissions: {}, scope: "turn" });
    const denial = f.warnings[f.warnings.length - 1]!;
    assert.equal(denial.event, "request_denied");
    assert.deepEqual(denial.data, {
      rpcId: 1, requestId: reference.requestId,
      threadId: overrides.threadId ?? "thread-1", turnId: "turn-1", itemId: "native-item-1",
    });
    assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "pending");
  }
  assert.equal(f.errorEvents.length, 0);
  assert.equal(callbacks, 0);
  await f.finish();
});

test("Matching native mirror fields preserve the exact registered read-only grant", async (t) => {
  const f = await fixture(t);
  for (const network of [null, { enabled: false }, { enabled: null }]) {
    const reference = registerAgentPermissionRequest(f.delivery, f.target);
    const entries = [{ path: { type: "path", path: f.target }, access: "read" }];
    assert.deepEqual(f.invoke(reference, { permissions: {
      network, fileSystem: { entries, read: [f.target], write: [], globScanMaxDepth: null },
    } }), { permissions: { fileSystem: { entries } }, scope: "turn" });
    assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "completed");
  }
  assert.equal(f.warnings.length, 0);
  assert.equal(f.errorEvents.length, 0);
  await f.finish();
});

for (const operation of ["get", "complete"] as const) {
  test(`RequestHub ${operation} failure denies access but is logged as an internal error`, async (t) => {
    const f = await fixture(t);
    let callbacks = 0;
    const reference = registerAgentPermissionRequest(f.delivery, f.target, { callback: () => { callbacks += 1; } });
    const fault = new Error(`Hub ${operation} failure`);
    const injected = t.mock.method(f.scope.requestHub, operation, () => { throw fault; });
    assert.deepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
    injected.mock.restore();
    assert.equal(f.warnings.length, 0);
    assert.equal(f.errorEvents.length, 1);
    assert.equal(f.errorEvents[0]?.event, "request_failed");
    assert.equal(f.errorEvents[0]?.message, fault.stack);
    assert.deepEqual(f.errorEvents[0]?.data, {
      rpcId: 1, requestId: reference.requestId, threadId: "thread-1", turnId: "turn-1", itemId: "native-item-1",
    });
    assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "pending");
    assert.equal(callbacks, 0);
    await f.finish();
  });
}

test("Lost Agent Turn ownership is a denial rather than a request service fault", async (t) => {
  const f = await fixture(t);
  const reference = registerAgentPermissionRequest(f.delivery, f.target);
  const caller = f.scope.agentRegistry.resolveAgentByThreadId("thread-1")!;
  t.mock.method(caller, "assertOwnsActiveTurn", () => { throw new Error("Agent no longer owns this Turn."); });
  assert.deepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
  assert.equal(f.warnings[0]?.event, "request_denied");
  assert.match(f.warnings[0]?.message ?? "", /no longer owns/);
  assert.equal(f.errorEvents.length, 0);
  assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "pending");
  await f.finish();
});

test("Permission registration canonicalizes its target and rejects relative or absent paths", async (t) => {
  const f = await fixture(t);
  assert.throws(() => registerAgentPermissionRequest(f.delivery, "target"), /must be absolute/);
  assert.throws(() => registerAgentPermissionRequest(f.delivery, join(f.root, "absent")), /ENOENT/);
  const link = join(f.root, "target-link");
  symlinkSync(f.target, link);
  const reference = registerAgentPermissionRequest(f.delivery, link);
  assert.equal(reference.path, f.target);
  assert.notDeepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
  await f.finish();
});

test("A pending business callback does not delay the native response or permit a second approval", async (t) => {
  const f = await fixture(t);
  let finishCallback!: () => void;
  const completion = new Promise<void>((resolve) => { finishCallback = resolve; });
  let callbacks = 0;
  const reference = registerAgentPermissionRequest(f.delivery, f.target, { callback: () => {
    callbacks += 1;
    return completion;
  } });
  assert.notDeepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
  assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "completed");
  await Promise.resolve();
  assert.equal(callbacks, 1);
  assert.deepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
  await f.finish();
  finishCallback();
  await completion;
});

test("Turn expiry uses the registered identity, ignores unrelated turns, and retains the expired record", async (t) => {
  const f = await fixture(t);
  const reference = registerAgentPermissionRequest(f.delivery, f.target);
  f.delivery.turnId = "caller-mutated-delivery";
  await f.scope.eventBus.publishAndWait<AgentTurnCompletedEvent>(AgentEvents.turn.completed, { turn: {
    agentId: "executor", role: "executor", invocationId: "invocation-2", threadId: "thread-1", turnId: "other-turn",
    status: "completed", startedAt: "2026-09-29T00:00:00.000Z", finishedAt: "2026-09-29T00:00:01.000Z",
  } });
  assert.equal(f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)?.status, "pending");
  await f.finish("failed");
  const record = f.scope.requestHub.get(agentPermissionRequestType, reference.requestId)!;
  assert.equal(record.status, "expired");
  assert.equal(record.payload.turnId, "turn-1");
  assert.deepEqual(f.invoke(reference), { permissions: {}, scope: "turn" });
});

test("Request Backend subscribes once, leaves dynamic tools unclaimed, and unsubscribes on stop", async (t) => {
  const f = await fixture(t);
  const backend = new AgentRequestBackend();
  backend.start(); backend.start();
  assert.equal(f.handlers.size, 1);
  const handler = [...f.handlers][0]!;
  assert.equal(await handler({ id: 1, method: "item/tool/call" }, {
    sendResult: () => assert.fail("Must use the dynamic-tool entry"), sendError: () => assert.fail(),
  }), false);
  const responses: unknown[] = [];
  assert.equal(await handler({ id: 2, method: "item/permissions/requestApproval", params: null }, {
    sendResult: (result) => { responses.push(result); }, sendError: () => assert.fail(),
  }), true);
  assert.deepEqual(responses, [{ permissions: {}, scope: "turn" }]);
  backend.stop(); backend.stop();
  assert.equal(f.handlers.size, 0);
});

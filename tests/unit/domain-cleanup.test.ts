import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BaseDomain, ScoutDomainId } from "../../src/domain/index.js";
import { RbtDomain, JarvisWebSocketTool } from "../../src/domain/domains/rbt/index.js";
import { JarvisBehaviorAndroidWebSocketLink } from "../../src/domain/domains/rbt/agent/tools/jarvis-websocket/links/jarvis-behavior-android-websocket-link.js";
import { HostCommandExecutor, type HostCommandRequest, type HostCommandResult } from "../../src/host/host-command-executor.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("Base stop closes its journal even when execution cleanup and logging fail", async (t) => {
  const scope = await installTestRunScope(t, { runId: "base-cleanup-failures" });
  const base = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  const executionFailure = new Error("execution cleanup failed");
  const logFailure = new Error("stop log failed");
  const execution = t.mock.method(base.execution, "stop", () => { throw executionFailure; });
  const logger = t.mock.method(scope.logger, "info", () => { throw logFailure; });
  assert.throws(() => base.stop(), (error) => error instanceof AggregateError
    && error.errors.includes(executionFailure) && error.errors.includes(logFailure));
  assert.equal(existsSync(join(scope.workflow.journalRoot, ".base.lock")), false);
  execution.mock.restore();
  logger.mock.restore();
  base.stop();
});

test("RBT stop closes its journal despite WebSocket failure, then retries remaining cleanup", async (t) => {
  const websocket = new JarvisWebSocketTool();
  const failure = new Error("websocket cleanup failed");
  let attempts = 0;
  t.mock.method(websocket, "stop", async () => { if (++attempts === 1) throw failure; });
  const domain = new RbtDomain({ websocket });
  const scope = await installTestRunScope(t, { runId: "rbt-cleanup-failure", scoutRoot: process.cwd(), domain });
  await domain.start();
  await assert.rejects(domain.stop(), (error) => error instanceof AggregateError && error.errors.includes(failure));
  assert.equal(existsSync(join(scope.workflow.journalRoot, ".rbt-events.lock")), false);
  await assert.rejects(domain.start(), /previous cleanup completes/);
  await domain.stop();
  assert.equal(attempts, 2);
});

test("RBT startup preserves the primary error while closing journals after failed WebSocket cleanup", async (t) => {
  const websocket = new JarvisWebSocketTool();
  const domain = new RbtDomain({ websocket });
  const scope = await installTestRunScope(t, { runId: "rbt-start-cleanup-failure", scoutRoot: process.cwd(), domain });
  const primary = new Error("RBT benchmarks startup failed");
  const cleanup = new Error("WebSocket cleanup failed");
  const startBenchmarks = t.mock.method(domain.benchmarks, "start", () => { throw primary; });
  const stopWebSocket = t.mock.method(websocket, "stop", async () => { throw cleanup; });
  await assert.rejects(domain.start(), (error) => error instanceof AggregateError
    && error.errors[0] === primary
    && error.errors[1] instanceof AggregateError
    && error.errors[1].errors.includes(cleanup));
  assert.equal(existsSync(join(scope.workflow.journalRoot, ".rbt-events.lock")), false);
  startBenchmarks.mock.restore();
  stopWebSocket.mock.restore();
  await domain.stop();
});

test("WebSocket shutdown retains failed sessions and platform links while releasing independent resources", async (t) => {
  const host = new HostCommandExecutor();
  const disconnected: string[] = [];
  let fail = true;
  let closes = 0;
  const result = (failed: boolean, stdout = ""): HostCommandResult => ({
    status: failed ? "failed" : "completed", exitCode: failed ? 1 : 0,
    stdout, stderr: "", durationMs: 0, ...(failed ? { error: "disconnect failed" } : {}),
  });
  t.mock.method(host, "run", async (request: HostCommandRequest) => {
    const sessionId = request.args?.at(-1) ?? "";
    if (request.args?.includes("status")) return result(false, JSON.stringify({ connected: true, endpoint: "ws://test" }));
    disconnected.push(sessionId);
    return result(fail && sessionId === "failing");
  });
  const websocket = new JarvisWebSocketTool(host, (input) => ({
    identity: input.identity,
    async prepare() { return { ok: true, launchParameters: {}, hostCommands: [] }; },
    async connect() { return { ok: true, endpoint: "ws://test", hostCommands: [] }; },
    async close() { closes += 1; if (fail) throw new Error("platform cleanup failed"); },
  }));
  await websocket.preparePlatformLink({ identity: { type: "android", version: "1" }, executable: "unused", baseArgs: [], cwd: "/tmp" });
  for (const sessionId of ["failing", "successful"]) {
    await websocket.ensureSession({ agentId: "test", sessionId, endpoint: "ws://test", executable: "unused", baseArgs: [], cwd: "/tmp" });
  }
  await assert.rejects(websocket.stop(), (error) => error instanceof AggregateError && error.errors.length === 2);
  assert.ok(websocket.session("failing"));
  assert.equal(websocket.session("successful"), undefined);
  assert.deepEqual(disconnected, ["failing", "successful"]);
  assert.equal(closes, 1);
  fail = false;
  await websocket.stop();
  assert.equal(websocket.session("failing"), undefined);
  assert.deepEqual(disconnected, ["failing", "successful", "failing"]);
  assert.equal(closes, 2);
});

test("WebSocket preparation retries a failed link close before creating or reusing a connection", async () => {
  let fail = true;
  let created = 0;
  let prepared = 0;
  const websocket = new JarvisWebSocketTool(new HostCommandExecutor(), (input) => {
    created += 1;
    return {
      identity: input.identity,
      async prepare() { prepared += 1; return { ok: true, launchParameters: {}, hostCommands: [] }; },
      async connect() { return { ok: true, endpoint: "ws://test", hostCommands: [] }; },
      async close() { if (fail) throw new Error("close failed"); },
    };
  });
  const input = { identity: { type: "android", version: "1" }, executable: "unused", baseArgs: [], cwd: "/tmp" };
  await websocket.preparePlatformLink(input);
  await assert.rejects(websocket.closePlatformLink(), /close failed/);
  await assert.rejects(websocket.preparePlatformLink(input), /close failed/);
  assert.equal(created, 1);
  assert.equal(prepared, 1);
  fail = false;
  await websocket.preparePlatformLink(input);
  assert.equal(created, 2);
  assert.equal(prepared, 2);
  await websocket.stop();
});

test("Android link cleanup releases both mappings and retains only failed ownership receipts", async (t) => {
  const link = new JarvisBehaviorAndroidWebSocketLink({
    identity: { type: "android", version: "1" }, executable: "unused", baseArgs: [], cwd: "/tmp",
  });
  // Model already-created mapping receipts without modifying a physical device.
  Object.assign(link, { forwardCreated: true, reverseCreated: true });
  let failForward = true;
  const removed: string[] = [];
  t.mock.method(HostCommandExecutor.prototype, "run", async (request: HostCommandRequest): Promise<HostCommandResult> => {
    const mapping = request.args?.[0] ?? "";
    removed.push(mapping);
    const failed = failForward && mapping === "forward";
    return { status: failed ? "failed" : "completed", exitCode: failed ? 1 : 0, stdout: "", stderr: "", durationMs: 0 };
  });
  await assert.rejects(link.close(), (error) => error instanceof AggregateError && error.errors.length === 1);
  assert.deepEqual(removed, ["forward", "reverse"]);
  failForward = false;
  await link.close();
  await link.close();
  assert.deepEqual(removed, ["forward", "reverse", "forward"]);
});

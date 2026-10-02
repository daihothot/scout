import { BaseDomainProjector } from "../../src/domain/domains/base/index.js";
import { decodeBaseDomainRecords, type BaseDomainRecord } from "../../src/domain/domains/base/record/base-domain-record.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { BaseDomainExecution } from "../../src/domain/index.js";
import {
  ExecutionEvents,
  ScoutExecutionSystem,
  type ExecutionHandlerInvocation,
  type ExecutionHandlerResult,
} from "../../src/execution/index.js";

const request = { transport: "adb", platform: "android", appId: "com.example.first" };

test("Base semantic launch uses isolated runtime configuration and survives a Workflow state reset", async (t) => {
  const { execution, operations } = await fixture(t);
  const configuration = { ...request, parameters: { activity: "MainActivity" } };
  execution.configure(configuration);
  execution.configure(structuredClone(configuration));
  configuration.appId = "com.example.changed";
  configuration.parameters.activity = "ChangedActivity";
  assert.throws(() => execution.configure(configuration), /different configuration/);
  assert.ok((await execution.launch()).ok);
  assert.ok((await execution.launch()).ok);
  assert.ok((await execution.shutdown()).ok);
  assert.ok((await execution.shutdown()).ok);
  assert.deepEqual(operations.map((call) => call.operation), ["identify", "launch", "shutdown"]);
  assert.deepEqual(operations[1]!.parameters, {
    appId: request.appId, launchParameters: { activity: "MainActivity" },
  });
  execution.stop();
  assert.ok((await execution.launch()).ok);
  assert.deepEqual(operations.at(-1)!.parameters, operations[1]!.parameters);
});

test("Base semantic operations report missing runtime information without selecting a guessed target", async (t) => {
  const { execution, operations } = await fixture(t);
  const launch = await execution.launch();
  assert.ok(!launch.ok && launch.code === "execution_not_configured");
  execution.configure(request);
  const shutdown = await execution.shutdown();
  assert.ok(!shutdown.ok && shutdown.code === "execution_target_unavailable");
  assert.deepEqual(operations, []);
});

test("Base semantic launch and shutdown serialize the whole operation", async (t) => {
  const { execution, operations } = await fixture(t);
  execution.configure(request);
  const [launched, stopped] = await Promise.all([execution.launch(), execution.shutdown()]);
  assert.ok(launched.ok && launched.started);
  assert.ok(stopped.ok && !stopped.started);
  assert.deepEqual(operations.map((call) => call.operation), ["identify", "launch", "shutdown"]);
  const current = execution.current(request);
  assert.ok(current.ok && !current.started);
});

test("Base semantic shutdown uses restored facts without launch configuration or rediscovery", async (t) => {
  const { execution, system, eventBus, events, operations } = await fixture(t);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  assert.ok((await execution.ensureStarted(request, target.identity)).ok);
  const fact = new BaseDomainProjector().project(events);
  execution.stop();
  const restored = new BaseDomainExecution(eventBus, system);
  t.after(() => restored.stop());
  restored.restore(fact);
  const stopped = await restored.shutdown();
  assert.ok(stopped.ok && !stopped.started);
  assert.ok((await restored.shutdown()).ok);
  assert.deepEqual(operations.map((call) => call.operation), ["identify", "launch", "shutdown"]);
  assert.deepEqual(operations.at(-1)!.parameters, { appId: request.appId });
  assert.equal(new BaseDomainProjector().project(events).execution?.state, "stopped");
});

test("Base semantic shutdown failure preserves the running session and permits a later retry", async (t) => {
  let fail = true;
  const { execution, operations } = await fixture(t, (call) => call.operation === "shutdown" && fail
    ? { ok: false, code: "shutdown_failed", message: "Application did not exit." }
    : undefined);
  execution.configure(request);
  assert.ok((await execution.launch()).ok);
  assert.equal((await execution.shutdown()).ok, false);
  const current = execution.current(request);
  assert.ok(current.ok && current.started);
  fail = false;
  const stopped = await execution.shutdown();
  assert.ok(stopped.ok && !stopped.started);
  assert.deepEqual(operations.map((call) => call.operation), ["identify", "launch", "shutdown", "shutdown"]);
});

test("Base execution serializes state checks and deduplicates concurrent lifecycle requests", async (t) => {
  const { execution, operations } = await fixture(t);
  const targets = await Promise.all([execution.resolve(request), execution.resolve(request)]);
  assert.ok(targets[0]!.ok);
  assert.ok(targets[1]!.ok);
  const identity = targets[0]!.identity;
  const started = await Promise.all([
    execution.ensureStarted(request, identity),
    execution.ensureStarted(request, identity),
  ]);
  assert.ok(started.every((result) => result.ok && result.started));
  const stopped = await Promise.all([
    execution.ensureStopped(request, identity),
    execution.ensureStopped(request, identity),
  ]);
  assert.ok(stopped.every((result) => result.ok && !result.started));
  assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "launch", "shutdown"]);
});

test("Base execution rejects another app without changing the running target", async (t) => {
  const { execution, operations } = await fixture(t);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  assert.ok((await execution.ensureStarted(request, target.identity)).ok);
  const other = { ...request, appId: "com.example.second" };
  for (const result of [
    execution.current(other),
    await execution.resolve(other),
    await execution.ensureStarted(other, target.identity),
    await execution.ensureStopped(other, target.identity),
    await execution.ensureStopped({ transport: "adb", platform: "android" }, target.identity),
  ]) {
    assert.equal(result.ok, false);
  }
  assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "launch"]);
  const current = execution.current(request);
  assert.ok(current.ok && current.started);

  assert.ok((await execution.ensureStopped(request, target.identity)).ok);
  assert.ok((await execution.ensureStarted(other, target.identity)).ok);
  assert.equal(operations.at(-1)!.parameters.appId, other.appId);
});

test("Base execution does not switch transports while an application is running", async (t) => {
  const { execution, operations } = await fixture(t);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  await execution.ensureStarted(request, target.identity);
  const switched = await execution.resolve({ ...request, transport: "another-adb" });
  assert.equal(switched.ok, false);
  assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "launch"]);
  const current = execution.current(request);
  assert.ok(current.ok && current.started);
});

test("Base execution rejects a stale transport identity after target selection changes", async (t) => {
  const { execution, operations } = await fixture(t);
  const first = await execution.resolve(request);
  const nextRequest = { ...request, transport: "another-adb" };
  const next = await execution.resolve(nextRequest);
  assert.ok(first.ok && next.ok);
  assert.deepEqual(first.identity.platform, next.identity.platform);
  assert.notEqual(first.identity.transport, next.identity.transport);
  assert.equal((await execution.ensureStarted(nextRequest, first.identity)).ok, false);
  assert.equal((await execution.ensureStopped(nextRequest, first.identity)).ok, false);
  assert.ok((await execution.ensureStarted(nextRequest, next.identity)).ok);
  assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "identify", "launch"]);
  assert.deepEqual(operations.at(-1)!.identity, next.identity);
});

test("Base execution snapshots queued requests and never reuses prior launch parameters", async (t) => {
  const { execution, operations } = await fixture(t);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  const input = { ...request, parameters: { activity: "MainActivity" } };
  const started = execution.ensureStarted(input, target.identity);
  input.appId = "com.example.mutated";
  input.parameters.activity = "ChangedActivity";
  assert.ok((await started).ok);
  assert.deepEqual(operations.at(-1)!.parameters, {
    appId: request.appId, launchParameters: { activity: "MainActivity" },
  });
  assert.ok((await execution.ensureStopped(request, target.identity)).ok);
  const nextRequest = { ...request, appId: "com.example.second" };
  assert.ok((await execution.ensureStarted(nextRequest, target.identity)).ok);
  assert.deepEqual(operations.at(-1)!.parameters, { appId: nextRequest.appId });
});

test("Base execution conditionally rolls back a fresh launch exactly once", async (t) => {
  const { execution, operations } = await fixture(t);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  const started = await execution.ensureStarted(request, target.identity);
  assert.ok(started.ok && started.launched);
  assert.ok((await execution.rollbackStart(request, started.identity, started.launchId)).ok);
  assert.ok((await execution.rollbackStart(request, started.identity, started.launchId)).ok);
  const current = execution.current(request);
  assert.ok(current.ok && !current.started);
  assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "launch", "shutdown"]);
});

for (const reuse of ["resolve", "current", "ensureStarted"] as const) {
  test(`Base execution protects a launch reused through ${reuse} from earlier failure cleanup`, async (t) => {
    const { execution, operations } = await fixture(t);
    const target = await execution.resolve(request);
    assert.ok(target.ok);
    const started = await execution.ensureStarted(request, target.identity);
    assert.ok(started.ok && started.launched);
    const peer = reuse === "ensureStarted"
      ? execution.ensureStarted(request, target.identity)
      : execution[reuse](request);
    const cleanup = execution.rollbackStart(request, started.identity, started.launchId);
    const reused = await peer;
    assert.ok(reused.ok && reused.started);
    if ("launched" in reused) assert.equal(reused.launched, false);
    assert.ok((await cleanup).ok);
    assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "launch"]);
    const current = execution.current(request);
    assert.ok(current.ok && current.started);
  });
}

test("Base execution does not apply an old rollback receipt to a later launch", async (t) => {
  const { execution, operations } = await fixture(t);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  const first = await execution.ensureStarted(request, target.identity);
  assert.ok(first.ok && first.launched);
  assert.ok((await execution.ensureStopped(request, target.identity)).ok);
  const next = await execution.ensureStarted(request, target.identity);
  assert.ok(next.ok && next.launched);
  assert.notEqual(next.launchId, first.launchId);
  assert.ok((await execution.rollbackStart(request, first.identity, first.launchId)).ok);
  assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "launch", "shutdown", "launch"]);
  assert.ok((await execution.rollbackStart(request, next.identity, next.launchId)).ok);
  assert.equal(operations.at(-1)!.operation, "shutdown");
});

test("Base execution serializes competing apps and rejects the second launch", async (t) => {
  const { execution, operations } = await fixture(t);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  const [first, second] = await Promise.all([
    execution.ensureStarted(request, target.identity),
    execution.ensureStarted({ ...request, appId: "com.example.second" }, target.identity),
  ]);
  assert.ok(first.ok && first.launched);
  assert.ok(!second.ok && second.code === "execution_target_conflict");
  assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "launch"]);
  assert.ok((await execution.rollbackStart(request, first.identity, first.launchId)).ok);
  assert.equal(operations.at(-1)!.operation, "shutdown");
});

test("Base execution retries after a failed queued launch without poisoning later requests", async (t) => {
  let launches = 0;
  const { execution, operations } = await fixture(t, (call) => {
    if (call.operation === "launch" && ++launches === 1) {
      return { ok: false, code: "launch_failed", message: "First launch fails." };
    }
    return undefined;
  });
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  const results = await Promise.all([
    execution.ensureStarted(request, target.identity),
    execution.ensureStarted(request, target.identity),
  ]);
  assert.equal(results[0]!.ok, false);
  assert.ok(results[1]!.ok && results[1]!.started);
  assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "launch", "launch"]);
});

test("Base execution releases the state queue after a thrown command", async (t) => {
  let launches = 0;
  const { execution } = await fixture(t, (call) => {
    if (call.operation === "launch" && ++launches === 1) throw new Error("Handler disconnected.");
    return undefined;
  });
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  const first = execution.ensureStarted(request, target.identity);
  const next = execution.ensureStarted(request, target.identity);
  await assert.rejects(first, /Handler disconnected/);
  const started = await next;
  assert.ok(started.ok && started.launched);
});

test("Base execution and Journal replay agree after a repeated identify of a launched app", async (t) => {
  const { execution, system, events } = await fixture(t);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  await execution.ensureStarted(request, target.identity);
  await system.identify({ transport: request.transport, platform: request.platform });
  const fact = new BaseDomainProjector().project(events);
  assert.equal(fact.execution?.state, "launched");
  const restored = new BaseDomainExecution(new InMemoryEventBus(), system);
  t.after(() => restored.stop());
  restored.restore(fact);
  assert.deepEqual(restored.current(request), execution.current(request));
  assert.equal(restored.current({ ...request, appId: "com.example.second" }).ok, false);
});

test("Base execution and replay retain running state after unconfirmed operation failures", async (t) => {
  let fail = false;
  const { execution, system, events, operations } = await fixture(t, () => fail
    ? { ok: false, code: "command_failed", message: "No new execution state was confirmed." }
    : undefined);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  await execution.ensureStarted(request, target.identity);
  fail = true;
  for (const operation of ["identify", "launch", "shutdown"] as const) {
    const result = operation === "identify"
      ? await system.identify({ transport: request.transport, platform: request.platform })
      : await system[operation]({ appId: request.appId, identity: target.identity });
    assert.ok(!result.ok && result.code === "command_failed");
    const live = execution.current(request);
    assert.ok(live.ok && live.started, `${operation} failure must not imply shutdown`);
    const fact = new BaseDomainProjector().project(events);
    const restored = new BaseDomainExecution(new InMemoryEventBus(), system);
    try {
      restored.restore(fact);
      assert.deepEqual(restored.current(request), live);
    } finally {
      restored.stop();
    }
  }
  assert.deepEqual(operations.map((entry) => entry.operation), ["identify", "launch", "identify", "launch", "shutdown"]);
});

test("Base execution and replay both invalidate a target when the handler requires identify", async (t) => {
  let disconnected = false;
  const { execution, system, events } = await fixture(t, () => disconnected
    ? { ok: false, code: "handler_disconnected", message: "Identify again.", requiresIdentify: true }
    : undefined);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  await execution.ensureStarted(request, target.identity);
  disconnected = true;
  const result = await execution.ensureStopped(request, target.identity);
  assert.ok(!result.ok && result.code === "handler_disconnected");
  assert.equal(execution.current(request).ok, false);
  const fact = new BaseDomainProjector().project(events);
  assert.equal(fact.execution, undefined);
  const restored = new BaseDomainExecution(new InMemoryEventBus(), system);
  t.after(() => restored.stop());
  restored.restore(fact);
  assert.deepEqual(restored.current(request), execution.current(request));
  disconnected = false;
  assert.ok((await execution.resolve(request)).ok);
});

test("Base replay and live state ignore another app's shutdown and preserve a confirmed stop", async (t) => {
  const { execution, system, events } = await fixture(t);
  const target = await execution.resolve(request);
  assert.ok(target.ok);
  await execution.ensureStarted(request, target.identity);
  await system.shutdown({ identity: target.identity, appId: "com.example.second" });
  let fact = new BaseDomainProjector().project(events);
  assert.equal(fact.execution?.state, "launched");
  const running = execution.current(request);
  assert.ok(running.ok && running.started);
  await execution.ensureStopped(request, target.identity);
  await system.identify({ transport: request.transport, platform: request.platform });
  fact = new BaseDomainProjector().project(events);
  assert.equal(fact.execution?.state, "stopped");
  assert.equal(fact.execution.appId, request.appId);
  const restored = new BaseDomainExecution(new InMemoryEventBus(), system);
  t.after(() => restored.stop());
  restored.restore(fact);
  assert.deepEqual(restored.current(request), execution.current(request));
});

async function fixture(
  t: TestContext,
  resultFor?: (call: ExecutionHandlerInvocation) => ExecutionHandlerResult | undefined,
) {
  const eventBus = new InMemoryEventBus();
  const operations: ExecutionHandlerInvocation[] = [];
  const events: BaseDomainRecord[] = [];
  eventBus.subscribe(ExecutionEvents.execution, (event) => {
    events.push(...decodeBaseDomainRecords(JSON.parse(JSON.stringify([
      { ...event, version: 1, seq: events.length + 1, recordedAt: event.occurredAt },
    ]))));
  });
  const system = await ScoutExecutionSystem.start({
    async start() {},
    async invoke(call) {
      operations.push(structuredClone(call));
      const result = resultFor?.(call);
      if (result) return result;
      return call.operation === "identify"
        ? { ok: true, value: { transport: call.parameters.transport ?? "adb", platform: { type: "android", version: "34" } } }
        : { ok: true };
    },
    async close() {},
  }, eventBus);
  const execution = new BaseDomainExecution(eventBus, system);
  t.after(async () => { execution.stop(); await system.dispose(); });
  return { execution, system, eventBus, operations, events };
}

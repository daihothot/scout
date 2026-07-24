import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import type { ScoutDomain } from "../../src/domain/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import {
  RunRuntimeStage,
  RunScopeStage,
  RunStageExecutor,
  type RunStage,
} from "../../src/run/lifecycle/index.js";
import {
  currentRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import { RunEvents } from "../../src/run/events/index.js";
import { createTestRunPersistence } from "../helpers/run-persistence.js";

test("RunScopeStage creates the Run-owned stores and releases the installed scope", async (t) => {
  const runId = "boot-run-scope-test";
  const domain: ScoutDomain = {
    domainId: "test",
    name: "test",
    dynamicToolsForRole: () => [],
  };
  let terminationReason: string | undefined;
  const eventBus = new InMemoryEventBus();
  const scope = new RunScope({
    runId,
    repoRoot: "/repo",
    logger: noopLogger(),
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain,
    ...createTestRunPersistence(t, runId, "/repo", eventBus),
    terminate: async (reason) => {
      terminationReason = reason;
    },
  });
  const stage = new RunScopeStage(scope);

  assert.equal(stage.scopeCreated, false);
  await stage.start();

  assert.equal(stage.scopeCreated, true);
  assert.equal(currentRunScope(), stage.scope);
  assert.equal(stage.scope.runId, runId);
  assert.equal(stage.scope.domain, domain);
  assert.deepEqual(stage.scope.agentRegistry.listAgents(), []);
  assert.deepEqual(stage.scope.taskStore.listTasks(), []);
  assert.throws(() => stage.scope.appServer, /app-server is not available/);
  assert.throws(() => stage.scope.environment, /environment is not available/);

  await stage.scope.terminate("test_termination");
  assert.equal(terminationReason, "test_termination");

  await stage.stop();
  assert.throws(() => currentRunScope(), /No active Scout run scope/);
});

test("RunScopeStage remains available until every dependent stage stops", async (t) => {
  const logger = noopLogger();
  const boot = new RunStageExecutor({
    runId: "boot-run-scope-order",
    logger,
  });
  const eventBus = new InMemoryEventBus();
  const scope = new RunScope({
    runId: "boot-run-scope-order",
    repoRoot: "/repo",
    logger,
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    ...createTestRunPersistence(t, "boot-run-scope-order", "/repo", eventBus),
    terminate: (reason) => boot.terminate(reason),
  });
  const scopeStage = new RunScopeStage(scope);
  const observed: string[] = [];
  const dependentStage: RunStage = {
    id: "dependent",
    async start() {
      observed.push(`start:${currentRunScope().runId}`);
    },
    async stop() {
      observed.push(`stop:${currentRunScope().runId}`);
    },
  };
  boot.registerSerial(scopeStage, dependentStage);

  await boot.startup();
  await boot.terminate("test_cleanup");

  assert.deepEqual(observed, [
    "start:boot-run-scope-order",
    "stop:boot-run-scope-order",
  ]);
  assert.throws(() => currentRunScope(), /No active Scout run scope/);
});

test("RunScopeStage does not record an attachment when another run owns the process scope", async (t) => {
  const firstEventBus = new InMemoryEventBus();
  const firstPersistence = createTestRunPersistence(
    t,
    "run-scope-owner",
    "/repo",
    firstEventBus,
  );
  const first = new RunScopeStage(new RunScope({
    runId: "run-scope-owner",
    repoRoot: "/repo",
    logger: noopLogger(),
    eventBus: firstEventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    ...firstPersistence,
    terminate: async () => undefined,
  }));
  const secondEventBus = new InMemoryEventBus();
  const secondPersistence = createTestRunPersistence(
    t,
    "run-scope-rejected",
    "/repo",
    secondEventBus,
  );
  const second = new RunScopeStage(new RunScope({
    runId: "run-scope-rejected",
    repoRoot: "/repo",
    logger: noopLogger(),
    eventBus: secondEventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    ...secondPersistence,
    terminate: async () => undefined,
  }));

  await first.start();
  try {
    await assert.rejects(second.start(), /Run scope already installed: run-scope-owner/);
    assert.equal(currentRunScope(), first.scope);
    assert.equal(
      secondPersistence.journal.readAll().some((event) =>
        RunEvents.runtime.attached.is(event)
      ),
      false,
    );
    assert.equal(secondPersistence.manifestStore.read().runtime.status, "created");
  } finally {
    await second.stop();
    await first.stop();
  }
});

test("RunScopeStage detaches normally after a previous Journal write failure", async (t) => {
  const runId = "run-scope-journal-failed";
  const eventBus = new InMemoryEventBus();
  const persistence = createTestRunPersistence(t, runId, "/repo", eventBus);
  const scopeStage = new RunScopeStage(new RunScope({
    runId,
    repoRoot: "/repo",
    logger: noopLogger(),
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    ...persistence,
    terminate: async () => undefined,
  }));
  const runtimeStage = new RunRuntimeStage("start");
  let runtimeStopEvents = 0;
  eventBus.subscribe(RunEvents.runtime.interrupted, () => {
    runtimeStopEvents += 1;
  });
  eventBus.subscribe(RunEvents.runtime.detached, () => {
    runtimeStopEvents += 1;
  });
  await scopeStage.start();
  await runtimeStage.start();
  assert.throws(() => {
    persistence.journal.append({
      id: "unserializable-event",
      key: RunEvents.runtime.ready,
      payload: () => undefined,
      occurredAt: "2026-07-23T00:00:00.000Z",
    });
  });

  await runtimeStage.stop("test_cleanup");
  await scopeStage.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(runtimeStopEvents, 1);
  assert.deepEqual(persistence.manifestStore.read().runtime, {
    status: "detached",
    reason: "test_cleanup",
  });
  assert.throws(() => currentRunScope(), /No active Scout run scope/);
});

function noopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

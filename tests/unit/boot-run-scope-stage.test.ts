import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import type { ScoutDomain } from "../../src/domain/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import {
  BootExecutor,
  BootRunScopeStage,
  type BootStage,
} from "../../src/run/boot/index.js";
import { currentRunScope } from "../../src/run/run-scope.js";

test("BootRunScopeStage creates the Run-owned stores and releases the installed scope", async () => {
  const runId = "boot-run-scope-test";
  const domain: ScoutDomain = {
    domainId: "test",
    name: "test",
    dynamicToolsForRole: () => [],
  };
  let terminationReason: string | undefined;
  const stage = new BootRunScopeStage({
    runId,
    repoRoot: "/repo",
    logger: noopLogger(),
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain,
    terminate: async (reason) => {
      terminationReason = reason;
    },
  });

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

test("BootRunScopeStage remains available until every dependent stage stops", async () => {
  const logger = noopLogger();
  const boot = new BootExecutor({
    runId: "boot-run-scope-order",
    logger,
  });
  const scopeStage = new BootRunScopeStage({
    runId: "boot-run-scope-order",
    repoRoot: "/repo",
    logger,
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    terminate: (reason) => boot.terminate(reason),
  });
  const observed: string[] = [];
  const dependentStage: BootStage = {
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

function noopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

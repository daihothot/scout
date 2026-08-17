import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import {
  currentRunScope,
  installRunScope,
  RunScope,
} from "../../src/run/run-scope.js";
import type { RunEnvironment } from "../../src/run/types.js";
import { createTestRunPersistence } from "../helpers/run-persistence.js";

test("currentRunScope rejects access outside an active run", () => {
  assert.throws(() => currentRunScope(), /No active Scout run scope/);
});

test("installRunScope exposes one run scope until release", (t) => {
  const scope = createRunScope(t, "run-scope-active");
  const release = installRunScope(scope);

  assert.equal(currentRunScope(), scope);

  release();
  assert.throws(() => currentRunScope(), /No active Scout run scope/);
});

test("installRunScope rejects a second active run without replacing the first", (t) => {
  const first = createRunScope(t, "run-scope-first");
  const release = installRunScope(first);

  try {
    assert.throws(
      () => installRunScope(createRunScope(t, "run-scope-second")),
      /Run scope already installed: run-scope-first/,
    );
    assert.equal(currentRunScope(), first);
  } finally {
    release();
  }
});

test("run scope release cannot be applied twice", (t) => {
  const release = installRunScope(createRunScope(t, "run-scope-release"));

  release();

  assert.throws(
    () => release(),
    /Cannot release inactive run scope: run-scope-release/,
  );
});

test("RunScope exposes staged resources only after their owner registers them", (t) => {
  const scope = createRunScope(t, "run-scope-resources");
  const appServer = {} as RunScope["appServer"];
  const environment = createRunEnvironment(scope.runId);

  assert.throws(() => scope.appServer, /app-server is not available/);
  assert.throws(() => scope.environment, /environment is not available/);
  assert.equal(scope.hasEnvironment, false);

  scope.setAppServer(appServer);
  scope.setEnvironment(environment);

  assert.equal(scope.appServer, appServer);
  assert.equal(scope.environment, environment);
  assert.equal(scope.contextBundle, environment.contextBundle);
  assert.equal(scope.hasEnvironment, true);
  assert.throws(() => scope.setAppServer(appServer), /already available/);
  assert.throws(() => scope.setEnvironment(environment), /already available/);

  scope.clearAppServer(appServer);
  assert.throws(() => scope.appServer, /app-server is not available/);
});

test("RunScope rejects clearing a client it does not own", (t) => {
  const scope = createRunScope(t, "run-scope-client-owner");
  const appServer = {} as RunScope["appServer"];

  scope.setAppServer(appServer);

  assert.throws(
    () => scope.clearAppServer({} as RunScope["appServer"]),
    /inactive run app-server/,
  );
  assert.equal(scope.appServer, appServer);
});

function createRunScope(t: import("node:test").TestContext, runId: string): RunScope {
  return new RunScope({
    runId,
    scoutRoot: "/repo",
    logger: {} as RunScope["logger"],
    eventBus: new InMemoryEventBus(),
    interactionPort: new NoopRuntimeInteractionPort(),
    domain: {
      domainId: "test",
      name: "test",
      dynamicToolsForRole: () => [],
    },
    ...createTestRunPersistence(t, runId),
    terminate: async () => undefined,
  });
}

function createRunEnvironment(runId: string): RunEnvironment {
  return {
    agents: {} as RunEnvironment["agents"],
    rootAccess: {
      mountRoots: [],
      readableRoots: [],
      writableRoots: [],
    },
    contextBundle: {
      contextBundleId: `context-${runId}`,
      runId,
      assetCommit: {} as RunEnvironment["contextBundle"]["assetCommit"],
      sharedInputs: {
        mountRoot: "/repo/mount",
        manifestPath: "/repo/mount/mount-manifest.json",
        resourceHash: "test",
      },
    },
  };
}

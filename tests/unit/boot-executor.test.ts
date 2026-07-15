import test from "node:test";
import assert from "node:assert/strict";
import {
  BootExecutor,
  type BootStage,
} from "../../src/run/boot/index.js";
import type { Logger } from "../../src/core/logging/index.js";

test("BootExecutor starts registered groups and terminates them in reverse dependency order", async () => {
  const activity: string[] = [];
  const boot = new BootExecutor({ runId: "run-1", logger: noopLogger() });
  boot.registerSerial(
    stage("a", activity),
    stage("b", activity),
  );
  boot.registerParallel(
    stage("c", activity),
    stage("d", activity),
  );

  await boot.startup();
  await boot.terminate("test_cleanup");

  assert.deepEqual(activity.slice(0, 4), ["start:a", "start:b", "start:c", "start:d"]);
  const stopC = activity.indexOf("stop:c:test_cleanup");
  const stopD = activity.indexOf("stop:d:test_cleanup");
  const stopB = activity.indexOf("stop:b:test_cleanup");
  const stopA = activity.indexOf("stop:a:test_cleanup");
  assert.ok(stopC >= 4 && stopD >= 4);
  assert.ok(stopC < stopB && stopD < stopB);
  assert.ok(stopB < stopA);
  assert.equal(boot.snapshot().status, "terminated");
  assert.ok(boot.snapshot().stages.every((entry) => entry.status === "stopped"));
});

test("BootExecutor waits for a parallel group to settle before rolling back successful stages", async () => {
  const activity: string[] = [];
  const boot = new BootExecutor({ runId: "run-2", logger: noopLogger() });
  boot.registerSerial(stage("base", activity));
  boot.registerParallel(
    {
      id: "failed",
      async start() {
        activity.push("start:failed");
        throw new Error("parallel failed");
      },
    },
    {
      id: "slow",
      async start() {
        activity.push("start:slow");
        await new Promise((resolve) => setTimeout(resolve, 5));
        activity.push("complete:slow");
      },
      async stop(reason) {
        activity.push(`stop:slow:${reason}`);
      },
    },
  );

  await assert.rejects(boot.startup(), /parallel failed/);

  assert.ok(activity.indexOf("complete:slow") < activity.indexOf("stop:slow:startup_failed"));
  assert.ok(activity.indexOf("stop:slow:startup_failed") < activity.indexOf("stop:base:startup_failed"));
  assert.equal(boot.snapshot().status, "failed");
  assert.equal(boot.snapshot().stages.find((entry) => entry.id === "failed")?.status, "failed");
});

test("BootExecutor terminates after the active startup group settles and skips later groups", async () => {
  const activity: string[] = [];
  let releaseStart: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let markRunning: (() => void) | undefined;
  const running = new Promise<void>((resolve) => {
    markRunning = resolve;
  });
  const boot = new BootExecutor({ runId: "run-3", logger: noopLogger() });
  boot.registerSerial(
    {
      id: "slow",
      async start() {
        activity.push("start:slow");
        markRunning?.();
        await started;
      },
      async stop(reason) {
        activity.push(`stop:slow:${reason}`);
      },
    },
    stage("never", activity),
  );

  const startup = boot.startup();
  await running;
  const termination = boot.terminate("exit_requested");
  releaseStart?.();

  await termination;
  await assert.rejects(startup, /terminated/);
  assert.deepEqual(activity, ["start:slow", "stop:slow:exit_requested"]);
  assert.equal(boot.snapshot().status, "terminated");
});

test("BootExecutor rejects duplicate and late registration and shares termination", async () => {
  const boot = new BootExecutor({ runId: "run-4", logger: noopLogger() });
  boot.registerSerial(stage("only", []));
  assert.throws(() => boot.registerParallel(stage("only", [])), /Duplicate/);
  await boot.startup();
  assert.throws(() => boot.registerSerial(stage("late", [])), /before startup/);
  const first = boot.terminate("first");
  const second = boot.terminate("second");
  assert.equal(first, second);
  await first;
});

test("BootExecutor continues reverse termination after a stage fails to stop", async () => {
  const activity: string[] = [];
  const boot = new BootExecutor({ runId: "run-5", logger: noopLogger() });
  boot.registerSerial(
    stage("first", activity),
    {
      id: "second",
      async start() {
        activity.push("start:second");
      },
      async stop() {
        activity.push("stop:second");
        throw new Error("stop failed");
      },
    },
  );

  await boot.startup();
  await boot.terminate("test_cleanup");

  assert.deepEqual(activity, [
    "start:first",
    "start:second",
    "stop:second",
    "stop:first:test_cleanup",
  ]);
  assert.equal(boot.snapshot().status, "failed");
  assert.equal(boot.snapshot().stages.find((entry) => entry.id === "second")?.status, "failed");
  assert.equal(boot.snapshot().stages.find((entry) => entry.id === "first")?.status, "stopped");
});

function stage(id: string, activity: string[]): BootStage {
  return {
    id,
    async start() {
      activity.push(`start:${id}`);
    },
    async stop(reason) {
      activity.push(`stop:${id}:${reason}`);
    },
  };
}

function noopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

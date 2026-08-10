import test from "node:test";
import assert from "node:assert/strict";
import {
  RunStageExecutor,
  type RunStage,
} from "../../src/run/lifecycle/index.js";
import type { Logger, LogInput, LogLevel } from "../../src/core/logging/index.js";

interface CapturedLog {
  level: LogLevel;
  input: LogInput;
}

test("RunStageExecutor starts registered groups and terminates them in reverse dependency order", async () => {
  const activity: string[] = [];
  const logs: CapturedLog[] = [];
  const boot = new RunStageExecutor({ runId: "run-1", logger: recordingLogger(logs) });
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

  const stageStarted = capturedEvent(logs, "run_stage_started", "a");
  assert.match(stageStarted.input.message ?? "", /stage a \(1\/4\).*serial group/);
  assert.deepEqual(stageStarted.input.data, {
    stage: "a",
    stageIndex: 1,
    stageCount: 4,
    groupMode: "serial",
    completedStages: 0,
    remainingStages: 4,
    elapsedMs: (stageStarted.input.data as Record<string, unknown>).elapsedMs,
  });
  assertNonNegativeNumber((stageStarted.input.data as Record<string, unknown>).elapsedMs);

  const stageCompleted = capturedEvent(logs, "run_stage_completed", "d");
  assert.equal((stageCompleted.input.data as Record<string, unknown>).stageIndex, 4);
  assert.equal((stageCompleted.input.data as Record<string, unknown>).groupMode, "parallel");
  assert.equal((stageCompleted.input.data as Record<string, unknown>).completedStages, 4);
  assert.equal((stageCompleted.input.data as Record<string, unknown>).remainingStages, 0);

  const stageStopped = capturedEvent(logs, "run_stage_stopped", "a");
  assertNonNegativeNumber((stageStopped.input.data as Record<string, unknown>).durationMs);
  assertNonNegativeNumber((stageStopped.input.data as Record<string, unknown>).elapsedMs);
});

test("RunStageExecutor waits for a parallel group to settle before rolling back successful stages", async () => {
  const activity: string[] = [];
  const boot = new RunStageExecutor({ runId: "run-2", logger: noopLogger() });
  boot.registerSerial(stage("base", activity));
  boot.registerParallel(
    {
      id: "failed",
      async start() {
        activity.push("start:failed");
        throw new Error("parallel failed");
      },
      async stop(reason) {
        activity.push(`stop:failed:${reason}`);
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
  assert.ok(activity.includes("stop:failed:startup_failed"));
  assert.ok(activity.indexOf("stop:slow:startup_failed") < activity.indexOf("stop:base:startup_failed"));
  assert.equal(boot.snapshot().status, "failed");
  assert.equal(boot.snapshot().stages.find((entry) => entry.id === "failed")?.status, "stopped");
});

test("RunStageExecutor terminates after the active startup group settles and skips later groups", async () => {
  const activity: string[] = [];
  const logs: CapturedLog[] = [];
  let releaseStart: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let markRunning: (() => void) | undefined;
  const running = new Promise<void>((resolve) => {
    markRunning = resolve;
  });
  const boot = new RunStageExecutor({ runId: "run-3", logger: recordingLogger(logs) });
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
  assert.deepEqual(
    logs
      .filter(({ input }) => input.event.startsWith("run_termination_"))
      .map(({ input }) => input.event),
    ["run_termination_started", "run_termination_completed"],
  );
  const completed = capturedEvent(logs, "run_termination_completed");
  assertNonNegativeNumber((completed.input.data as Record<string, unknown>).durationMs);
});

test("RunStageExecutor rejects duplicate and late registration and shares termination", async () => {
  const boot = new RunStageExecutor({ runId: "run-4", logger: noopLogger() });
  boot.registerSerial(stage("only", []));
  assert.throws(() => boot.registerParallel(stage("only", [])), /Duplicate/);
  await boot.startup();
  assert.throws(() => boot.registerSerial(stage("late", [])), /before startup/);
  const first = boot.terminate("first");
  const second = boot.terminate("second");
  assert.equal(first, second);
  await first;
});

test("RunStageExecutor continues reverse termination after a stage fails to stop", async () => {
  const activity: string[] = [];
  const boot = new RunStageExecutor({ runId: "run-5", logger: noopLogger() });
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

function stage(id: string, activity: string[]): RunStage {
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

function recordingLogger(events: CapturedLog[]): Logger {
  const record = (level: LogLevel) => (input: LogInput): void => {
    events.push({ level, input });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  } as unknown as Logger;
}

function capturedEvent(logs: CapturedLog[], event: string, stage?: string): CapturedLog {
  const matched = logs.find(({ input }) =>
    input.event === event
    && (stage === undefined || (input.data as Record<string, unknown> | undefined)?.stage === stage)
  );
  assert.ok(matched, `Expected captured log event ${event}${stage ? ` for ${stage}` : ""}.`);
  return matched;
}

function assertNonNegativeNumber(value: unknown): void {
  assert.equal(typeof value, "number");
  assert.ok((value as number) >= 0);
}

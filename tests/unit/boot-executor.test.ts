import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunStageExecutor,
  WorkflowStage,
  type RunStage,
} from "../../src/run/lifecycle/index.js";
import { Logger, type LogInput, type LogLevel } from "../../src/core/logging/index.js";
import { startRun } from "../../src/run/startup/start-run.js";
import { PrepareEnvironmentStage } from "../../src/run/startup/stages/prepare-environment-stage.js";
import { currentRunScope } from "../../src/run/run-scope.js";
import { NoopRuntimeInteractionPort, type RuntimeDisclosureEvent } from "../../src/interaction/index.js";

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

test("RunStageExecutor releases every stage when the final startup log fails, even if cleanup observers also fail", async () => {
  const activity: string[] = [];
  const failure = new Error("ENOSPC at run_startup_completed");
  const logger = noopLogger();
  logger.info = (input) => {
    if (input.event === "run_startup_completed") throw failure;
    if (input.event === "run_stage_stopped") throw new Error("cleanup log unavailable");
  };
  logger.error = () => { throw new Error("error log unavailable"); };
  logger.warn = () => { throw new Error("warning log unavailable"); };
  const boot = new RunStageExecutor({
    runId: "log-failure", logger,
    onStateChange: () => { throw new Error("observer unavailable"); },
  });
  boot.registerSerial(stage("journal", activity), stage("clients", activity));

  await assert.rejects(boot.startup(), (error) => error === failure);
  await boot.terminate("test_cleanup");

  assert.deepEqual(activity, [
    "start:journal", "start:clients", "stop:clients:startup_failed", "stop:journal:startup_failed",
  ]);
  assert.equal(boot.snapshot().status, "failed");
});

test("RunStageExecutor preserves the stage error when failure diagnostics cannot be written", async () => {
  const activity: string[] = [];
  const failure = new Error("stage failed");
  const logger = noopLogger();
  logger.error = () => { throw new Error("error logger failed"); };
  const boot = new RunStageExecutor({ runId: "stage-error", logger });
  boot.registerSerial(stage("first", activity), {
    id: "second",
    async start() { throw failure; },
    async stop() { activity.push("stop:second"); },
  });
  await assert.rejects(boot.startup(), (error) => error === failure);
  assert.deepEqual(activity, ["start:first", "stop:second", "stop:first:startup_failed"]);
});

test("RunStageExecutor settles concurrent termination when every termination diagnostic fails", async () => {
  const activity: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const logger = noopLogger();
  logger.info = (input) => {
    if (input.event.startsWith("run_termination_") || input.event === "run_stage_stopped") {
      throw new Error("termination logger unavailable");
    }
  };
  logger.error = () => { throw new Error("error logger unavailable"); };
  const boot = new RunStageExecutor({ runId: "termination-log-error", logger });
  boot.registerSerial({
    id: "blocked",
    async start() { entered(); await blocked; },
    async stop() { activity.push("stopped"); },
  }, stage("never", activity));
  const starting = boot.startup();
  const rejected = assert.rejects(starting, /Run startup terminated/);
  await running;
  const termination = boot.terminate("cancel");
  assert.equal(boot.terminate("cancel-again"), termination);
  release();
  await Promise.all([termination, rejected]);
  assert.deepEqual(activity, ["stopped"]);
  assert.equal(boot.snapshot().status, "failed");
});

test("RunStageExecutor still stops ready resources when termination logging fails", async () => {
  const activity: string[] = [];
  const logger = noopLogger();
  const boot = new RunStageExecutor({ runId: "ready-stop-log-error", logger });
  boot.registerSerial(stage("resource", activity));
  await boot.startup();
  logger.info = () => { throw new Error("log unavailable"); };
  logger.error = () => { throw new Error("error log unavailable"); };
  await boot.terminate("stop");
  assert.deepEqual(activity, ["start:resource", "stop:resource:stop"]);
  assert.equal(boot.snapshot().status, "failed");
});

for (const [event, withEnvironment] of [
  ["run_startup_completed", false], ["run_ready", false], ["run_startup_completed", true],
] as const) {
  test(`startRun releases its real Workflow lock when ${event} logging fails (environment=${withEnvironment})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "scout-start-log-failure-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(join(process.cwd(), "assets", "scout"), join(root, "assets", "scout"), { recursive: true });
    if (withEnvironment) {
      cpSync(join(process.cwd(), "assets", "agent-runtimes"), join(root, "assets", "agent-runtimes"), { recursive: true });
    }
    const failure = new Error(`${event} unavailable`);
    const register = RunStageExecutor.prototype.registerSerial;
    t.mock.method(RunStageExecutor.prototype, "registerSerial", function (this: RunStageExecutor, ...stages: RunStage[]) {
      register.apply(this, stages.flatMap((stage) => {
        if (["run_scope", "workflow", "initialize_run"].includes(stage.id)) return [stage];
        if (withEnvironment && stage.id === "environment") {
          return [new PrepareEnvironmentStage({ preflightMount: async () => ({ status: "passed" }) })];
        }
        return [];
      }));
    });
    t.mock.method(RunStageExecutor.prototype, "registerParallel", () => undefined);
    let runRoot: string | undefined;
    const start = WorkflowStage.prototype.start;
    t.mock.method(WorkflowStage.prototype, "start", async function (this: WorkflowStage) {
      await start.call(this);
      runRoot = currentRunScope().runRoot;
      assert.equal(currentRunScope().workflow.snapshot(), undefined);
    });
    const info = Logger.prototype.info;
    t.mock.method(Logger.prototype, "info", function (this: Logger, input: LogInput) {
      if (input.event === event) throw failure;
      return info.call(this, input);
    });
    t.mock.method(Logger.prototype, "error", () => { throw new Error("failure logger unavailable"); });
    const disclosures: RuntimeDisclosureEvent[] = [];
    const interactionPort = new NoopRuntimeInteractionPort();
    t.mock.method(interactionPort, "disclose", async (event: RuntimeDisclosureEvent) => { disclosures.push(event); });

    if (withEnvironment) {
      const summary = await startRun({ cwd: root, interactionPort });
      assert.equal(summary.status, "failed");
      assert.ok(summary.agents.coordinator);
      assert.ok(disclosures.some((event) => event.source === "run.start"
        && JSON.stringify(event.data).includes(failure.message)));
    } else {
      await assert.rejects(startRun({ cwd: root, interactionPort }), (error) => error === failure);
    }

    assert.ok(runRoot);
    assert.equal(existsSync(join(runRoot, "workflows", "workflow-001")), false);
    assert.equal(existsSync(join(runRoot, ".workflow.lock")), false);
    assert.throws(() => currentRunScope(), /No active Scout run scope/);
  });
}

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

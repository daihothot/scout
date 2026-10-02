import { Workflow } from "../../src/core/workflow/workflow.js";
import { createTestGraph } from "../helpers/run-persistence.js";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AssetStore } from "../../src/asset-store/index.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import type { AgentThreadSnapshot } from "../../src/agent/thread/types.js";
import { Journal } from "../../src/core/journal/index.js";
import { Logger } from "../../src/core/logging/index.js";
import { WorkflowEvents } from "../../src/core/workflow/index.js";
import { ScoutBenchmarks } from "../../src/core/benchmarks/index.js";
import { Benchmarks } from "../../src/core/benchmarks/index.js";
import {
  NoopRuntimeInteractionPort,
  type RuntimeDisclosureEvent,
} from "../../src/interaction/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import { resumeRun } from "../../src/run/resume/resume-run.js";
import { ResumeClientsStage } from "../../src/run/resume/stages/resume-clients-stage.js";
import { AgentEntityRecovery } from "../../src/agent/orchestration/recovery/agent-entity-recovery.js";
import { AgentTaskRecovery } from "../../src/agent/orchestration/recovery/agent-task-recovery.js";
import { RestoreWorkflowStage } from "../../src/run/resume/stages/restore-workflow-stage.js";
import { AgentContextRecovery } from "../../src/agent/orchestration/recovery/agent-context-recovery.js";
import { RestoreEnvironmentStage } from "../../src/run/resume/stages/restore-environment-stage.js";
import { PrepareEnvironmentStage } from "../../src/run/startup/stages/prepare-environment-stage.js";
import { ExecutionStage, RunAppServerStage, RunStageExecutor, type RunStage } from "../../src/run/lifecycle/index.js";
import { currentRunScope } from "../../src/run/run-scope.js";
import { projectAgentWorkflow } from "../../src/agent/orchestration/projector/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import { AgentTaskStatuses, type AgentTaskState } from "../../src/agent/task/types.js";

test("resume finishes interrupted environment initialization in the same Run and Workflow, then uses restoration", async (t) => {
  const fixture = await createFixture(t, "rbt", true);
  fixture.manifestStore.update(({ agents: _agents, ...manifest }) => manifest);
  fixture.writeWorkflow(fixture.runId);
  cpSync(join(process.cwd(), "assets", "agent-runtimes"), join(fixture.root, "assets", "agent-runtimes"), { recursive: true });
  const journalBefore = readFileSync(fixture.journalPath, "utf8");
  const linksBefore = readFileSync(fixture.benchmarks.path, "utf8");
  const clients = t.mock.method(RunAppServerStage.prototype, "start", async () => {
    mkdirSync(join(currentRunScope().runRoot, "codex-home", ".codex"), { recursive: true });
  });
  const prepare = PrepareEnvironmentStage.prototype.start;
  const prepared = t.mock.method(PrepareEnvironmentStage.prototype, "start", async () => {
    await prepare.call(new PrepareEnvironmentStage({ preflightMount: async () => ({ status: "passed" }) }));
  });
  const interrupted = new Error("initialization interrupted before the environment index is committed");
  const update = RunManifestStore.prototype.update;
  let failCommit = true;
  t.mock.method(RunManifestStore.prototype, "update", function (this: RunManifestStore, change: Parameters<RunManifestStore["update"]>[0]) {
    return update.call(this, (manifest) => {
      const next = change(manifest);
      if (failCommit && next.agents !== undefined) {
        failCommit = false;
        throw interrupted;
      }
      return next;
    });
  });
  const reachedEnvironment = new Error("environment initialized");
  t.mock.method(ExecutionStage.prototype, "start", async () => {
    const scope = currentRunScope();
    assert.equal(scope.runId, fixture.runId);
    assert.equal(scope.workflow.snapshot(), undefined, "Services install before business recovery.");
    assert.deepEqual(Object.keys(scope.environment.agents).sort(), fixture.graphData.roles.map((role) => role.name).sort());
    throw reachedEnvironment;
  });
  const restored = new Error("existing environment selected for restoration");
  const restoring = t.mock.method(RestoreEnvironmentStage.prototype, "start", async () => { throw restored; });

  assert.equal(existsSync(join(fixture.runRoot, "codex-home")), false);
  await assert.rejects(resumeRun(fixture.options), (error) => error === interrupted);
  assert.equal(fixture.manifestStore.read().agents, undefined);
  assert.equal(existsSync(join(fixture.runRoot, "agents", "coordinator", "mount", "mount-manifest.json")), true);
  await assert.rejects(resumeRun(fixture.options), (error) => error === reachedEnvironment);
  assert.deepEqual(Object.keys(fixture.manifestStore.read().agents ?? {}).sort(), fixture.graphData.roles.map((role) => role.name).sort());
  await assert.rejects(resumeRun(fixture.options), (error) => error === restored);
  assert.equal(clients.mock.callCount(), 3);
  assert.equal(prepared.mock.callCount(), 2);
  assert.equal(restoring.mock.callCount(), 1);
  assert.equal(readFileSync(fixture.journalPath, "utf8"), journalBefore);
  assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), linksBefore);
  assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
  assert.equal(existsSync(join(fixture.journalRoot, ".scout.lock")), false);
});

for (const evidence of ["agent", "advanced", "missing-journal"] as const) {
  test(`resume rejects a missing environment index with ${evidence} evidence before starting services`, async (t) => {
    const fixture = await createFixture(t);
    fixture.manifestStore.update(({ agents: _agents, ...manifest }) => manifest);
    if (evidence !== "missing-journal") {
      fixture.writeWorkflow(fixture.runId);
      const journal = Journal.open({ journalId: "initialized-run", path: fixture.journalPath,
        lockPath: join(fixture.journalRoot, ".scout.lock") });
      try {
        if (evidence === "agent") {
          journal.append({
            id: "agent-started", key: AgentEvents.thread.started, occurredAt: fixture.createdAt,
            payload: {
              agentId: "coordinator", role: "coordinator", phases: ["Synthesis"],
              contextBundleId: "context-original", threadId: "thread-original",
              createdAt: fixture.createdAt, status: "active",
              startInput: { cwd: fixture.root, approvalPolicy: "never", permissions: "scout-coordinator", ephemeral: false },
              startResponse: {},
            },
          });
        } else {
          journal.append({ id: "advanced", key: WorkflowEvents.workflow.advanced,
            payload: { ...createTestGraph(fixture.graphData).advance("completed"), outcome: "completed", advancedAt: fixture.createdAt },
            occurredAt: fixture.createdAt });
        }
      } finally { journal.close(); }
    }
    const manifestBefore = readFileSync(fixture.manifestStore.path, "utf8");
    const linksBefore = readFileSync(fixture.benchmarks.path, "utf8");
    const journalBefore = existsSync(fixture.journalPath) ? readFileSync(fixture.journalPath, "utf8") : undefined;
    const clients = t.mock.method(ResumeClientsStage.prototype, "start");
    const prepare = t.mock.method(PrepareEnvironmentStage.prototype, "start");

    await assert.rejects(resumeRun(fixture.options), /Cannot initialize.*environment index is missing/);

    assert.equal(clients.mock.callCount(), 0);
    assert.equal(prepare.mock.callCount(), 0);
    assert.equal(existsSync(join(fixture.runRoot, "logs")), false);
    assert.equal(readFileSync(fixture.manifestStore.path, "utf8"), manifestBefore);
    assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), linksBefore);
    if (journalBefore !== undefined) assert.equal(readFileSync(fixture.journalPath, "utf8"), journalBefore);
    assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
    assert.deepEqual(fixture.disclosures, []);
  });
}

test("resume selects the requested Run's benchmark even while another Run holds its own lock", async (t) => {
  const fixture = await createFixture(t);
  fixture.writeWorkflow(fixture.runId);
  const journalBefore = readFileSync(fixture.journalPath, "utf8");
  const repositoryBenchmarkPath = join(fixture.root, "run", "benchmarks.json");
  const repositoryLinks = JSON.stringify({
    version: 1, currentWorkflow: "workflow-099", lastWorkflow: "workflow-099", lastRun: "workflow-099",
  });
  writeFileSync(repositoryBenchmarkPath, repositoryLinks);
  const otherRoot = join(fixture.root, "run", "run-other");
  const other = new ScoutBenchmarks(new Benchmarks(otherRoot));
  other.benchmarks.acquire();
  try {
    const prepared = other.prepareNext();
    other.recordStarted(prepared.workflowId);
    const otherJournalPath = join(prepared.journalRoot, "scout.journal");
    writeFileSync(otherJournalPath, "other Run evidence\n");
    const otherLinks = readFileSync(other.path, "utf8");
    const otherLock = readFileSync(join(otherRoot, ".workflow.lock"), "utf8");
    const stop = new Error("requested Run selected before starting external clients");
    const clients = mockOwnerRestore(t, async () => {
      const scope = currentRunScope();
      assert.equal(scope.runRoot, fixture.runRoot);
      assert.equal(scope.workflow.journalPath, fixture.journalPath);
      assert.equal(scope.workflow.snapshot()?.workflowId, "workflow-001");
      assert.equal(scope.workflow.readEvents().length, 2);
      throw stop;
    });

    await assert.rejects(resumeRun(fixture.options), (error) => error === stop);

    assert.equal(clients.mock.callCount(), 1);
    assert.equal(readFileSync(fixture.journalPath, "utf8"), journalBefore);
    assert.equal(readFileSync(repositoryBenchmarkPath, "utf8"), repositoryLinks);
    assert.equal(readFileSync(other.path, "utf8"), otherLinks);
    assert.equal(readFileSync(join(otherRoot, ".workflow.lock"), "utf8"), otherLock);
    assert.equal(readFileSync(otherJournalPath, "utf8"), "other Run evidence\n");
    assert.equal(existsSync(join(fixture.runRoot, ".workflow.lock")), false);
    assert.deepEqual(fixture.disclosures, []);
  } finally {
    other.benchmarks.release();
  }
});

test("resume does not fall back to a repository benchmark when the requested Run has no benchmark", async (t) => {
  const fixture = await createFixture(t);
  fixture.writeWorkflow(fixture.runId);
  const repositoryBenchmarkPath = join(fixture.root, "run", "benchmarks.json");
  const repositoryLinks = readFileSync(fixture.benchmarks.path, "utf8");
  writeFileSync(repositoryBenchmarkPath, repositoryLinks);
  rmSync(fixture.benchmarks.path);
  const manifestBefore = readFileSync(fixture.manifestStore.path, "utf8");
  const journalBefore = readFileSync(fixture.journalPath, "utf8");
  const stop = new Error("empty Run selected without repository fallback");
  const clients = mockAfterRecovery(t, async () => {
    assert.equal(currentRunScope().workflow.snapshot(), undefined);
    assert.deepEqual(currentRunScope().workflow.readEvents(), []);
    throw stop;
  });
  await assert.rejects(resumeRun(fixture.options), (error) => error === stop);
  assert.equal(clients.mock.callCount(), 1);
  assert.equal(readFileSync(fixture.manifestStore.path, "utf8"), manifestBefore);
  assert.equal(readFileSync(fixture.journalPath, "utf8"), journalBefore);
  assert.equal(readFileSync(repositoryBenchmarkPath, "utf8"), repositoryLinks);
  assert.equal(existsSync(fixture.benchmarks.path), false);
  assert.equal(existsSync(join(fixture.runRoot, ".workflow.lock")), false);
});

test("resume rejects another Run's current Workflow before starting runtime services", async (t) => {
  const fixture = await createFixture(t);
  fixture.writeWorkflow("run-other");
  const manifestBefore = readFileSync(fixture.manifestStore.path, "utf8");
  const benchmarksBefore = readFileSync(fixture.benchmarks.path, "utf8");
  const journalBefore = readFileSync(fixture.journalPath, "utf8");
  const clients = t.mock.method(ResumeClientsStage.prototype, "start");

  await assert.rejects(
    resumeRun(fixture.options),
    /Cannot resume run-requested: Workflow workflow-001 belongs to Run run-other/,
  );

  assert.equal(clients.mock.callCount(), 0);
  assert.equal(existsSync(join(fixture.runRoot, "logs")), false);
  assert.equal(readFileSync(fixture.manifestStore.path, "utf8"), manifestBefore);
  assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), benchmarksBefore);
  assert.equal(readFileSync(fixture.journalPath, "utf8"), journalBefore);
  assert.deepEqual(fixture.disclosures, []);
});

test("resume rejects a Workflow without run.created rather than treating it as missing", async (t) => {
  const fixture = await createFixture(t);
  fixture.writeWorkflow();
  const clients = t.mock.method(ResumeClientsStage.prototype, "start");

  await assert.rejects(resumeRun(fixture.options), /workflow-001 is missing run.created/);

  assert.equal(clients.mock.callCount(), 0);
  assert.equal(existsSync(join(fixture.runRoot, "logs")), false);
  assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
  assert.deepEqual(fixture.disclosures, []);
});

test("resume opens a matching Run's Workflow without replacing it", async (t) => {
  const fixture = await createFixture(t);
  fixture.writeWorkflow(fixture.runId);
  const manifestBefore = readFileSync(fixture.manifestStore.path, "utf8");
  const journalBefore = readFileSync(fixture.journalPath, "utf8");
  const stopBeforeExternalClients = new Error("stop before external clients");
  let reachedWorkflow = false;
  mockOwnerRestore(t, async () => {
    reachedWorkflow = true;
    const scope = currentRunScope();
    assert.equal(scope.runId, fixture.runId);
    assert.equal(scope.workflow.journalPath, fixture.journalPath);
    assert.deepEqual(scope.workflow.graph.snapshot(), fixture.graphData);
    assert.equal(scope.workflow.snapshot()?.workflowId, "workflow-001");
    assert.equal(scope.workflow.readEvents().length, 2);
    throw stopBeforeExternalClients;
  });

  await assert.rejects(resumeRun(fixture.options), (error) => error === stopBeforeExternalClients);

  assert.equal(reachedWorkflow, true);
  assert.equal(readFileSync(fixture.manifestStore.path, "utf8"), manifestBefore);
  assert.equal(readFileSync(fixture.journalPath, "utf8"), journalBefore);
  assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
  assert.deepEqual(fixture.disclosures, []);
});

test("resuming an older selected Workflow updates lastRun without changing history permalinks", async (t) => {
  const fixture = await createFixture(t);
  fixture.writeWorkflow(fixture.runId);
  const links = {
    currentWorkflow: "workflow-001", lastWorkflow: "workflow-099",
    lastRun: "workflow-099", lastSuccess: "workflow-088",
  };
  writeFileSync(fixture.benchmarks.path, JSON.stringify({ scout:
    Object.fromEntries(Object.entries(links).map(([name, workflowId]) => [name, { workflowId }])),
  }), "utf8");
  const stop = new Error("stop before external clients");
  mockOwnerRestore(t, async () => {
    assert.deepEqual(fixture.benchmarks.read(), { ...links, lastRun: "workflow-001" });
    throw stop;
  });
  await assert.rejects(resumeRun(fixture.options), (error) => error === stop);
  assert.deepEqual(fixture.benchmarks.read(), { ...links, lastRun: "workflow-001" });
});

for (const change of ["tail", "graph", "identity"] as const) {
  test(`resume rejects a ${change} change between pre-read and locked open without mutating benchmarks`, async (t) => {
    const fixture = await createFixture(t);
    fixture.writeWorkflow(fixture.runId);
    const before = readFileSync(fixture.benchmarks.path, "utf8");
    const open = Journal.open.bind(Journal);
    let changedContents = "";
    const race = t.mock.method(Journal, "open", (options: Parameters<typeof Journal.open>[0]) => {
      if (options.path === fixture.journalPath && !changedContents) {
        // Another owner commits and releases its lock after resume's initial
        // projection, but before the new Workflow acquires the journal.
        const previous = open(options);
        try {
          if (change === "identity") {
            previous.replaceAll(previous.readAll().map((event) => RunEvents.run.created.is(event)
              ? { ...event, payload: { ...event.payload, runId: "another-run" } }
              : event));
          } else if (change === "graph") {
            const terminal = createTestGraph(fixture.graphData).advance("error");
            previous.append({
              id: "concurrent-completion", key: WorkflowEvents.workflow.advanced,
              payload: { ...terminal, outcome: "error", advancedAt: fixture.createdAt },
              occurredAt: fixture.createdAt,
            });
          } else {
            previous.append({
              id: "concurrent-attachment", key: RunEvents.runtime.attached,
              payload: { mode: "resume", attachedAt: fixture.createdAt, processId: process.pid },
              occurredAt: fixture.createdAt,
            });
          }
        } finally {
          previous.close();
        }
        changedContents = readFileSync(fixture.journalPath, "utf8");
      }
      return open(options);
    });
    const clients = t.mock.method(ResumeClientsStage.prototype, "start");

    await assert.rejects(resumeRun(fixture.options), /recovery snapshot changed.*retry resume/);

    assert.equal(clients.mock.callCount(), 0);
    assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), before);
    assert.equal(readFileSync(fixture.journalPath, "utf8"), changedContents);
    assert.equal(existsSync(join(fixture.journalRoot, ".scout.lock")), false);
    assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
    race.mock.restore();
    const reopened = open({ journalId: "verification", path: fixture.journalPath,
      lockPath: join(fixture.journalRoot, ".scout.lock") });
    reopened.close();
  });
}

test("a failed lastRun write releases the restored Workflow's journal lock", async (t) => {
  const fixture = await createFixture(t);
  fixture.writeWorkflow(fixture.runId);
  const failure = new Error("lastRun unavailable");
  const before = readFileSync(fixture.benchmarks.path, "utf8");
  t.mock.method(ScoutBenchmarks.prototype, "recordRun", () => { throw failure; });
  const clients = t.mock.method(ResumeClientsStage.prototype, "start");
  await assert.rejects(resumeRun(fixture.options), (error) => error === failure);
  assert.equal(clients.mock.callCount(), 0);
  assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), before);
  assert.equal(existsSync(join(fixture.journalRoot, ".scout.lock")), false);
});

for (const failurePoint of ["ready-subscriber", "ready-log"] as const) {
  test(`resume terminates restored resources on ${failurePoint} failure and preserves the original error`, async (t) => {
    const fixture = await createFixture(t);
    fixture.writeWorkflow(fixture.runId);
    const failure = new Error(failurePoint);
    const activity: string[] = [];
    const register = RunStageExecutor.prototype.registerSerial;
    // Keep the real scope/workflow and entry-point ordering, replacing only
    // services that would connect to external runtimes in this unit test.
    t.mock.method(RunStageExecutor.prototype, "registerSerial", function (this: RunStageExecutor, ...stages: RunStage[]) {
      register.apply(this, stages.filter((stage) => [
        "run_scope", "workflow", "restore_workflow",
      ].includes(stage.id)));
    });
    const parallel = RunStageExecutor.prototype.registerParallel;
    t.mock.method(RunStageExecutor.prototype, "registerParallel", function (this: RunStageExecutor, ...stages: RunStage[]) {
      parallel.apply(this, stages.filter((stage) => stage.id === "orchestrator"));
    });
    t.mock.method(AgentEntityRecovery.prototype, "restore", async () => {
      activity.push("agents-restored");
      const scope = currentRunScope();
      scope.eventBus.subscribeOnce(RunEvents.runtime.ready, async () => {
        assert.deepEqual(activity, ["agents-restored", "messages-restored"]);
        assert.equal(scope.manifestStore.read().runtime?.status, "ready");
        activity.push("ready-started");
        await Promise.resolve();
        if (failurePoint === "ready-subscriber") throw failure;
        activity.push("ready-finished");
      });
    });
    t.mock.method(AgentEntityRecovery.prototype, "stop", async () => { activity.push("agents-stopped"); });
    t.mock.method(AgentContextRecovery.prototype, "restore", async () => { activity.push("messages-restored"); });
    t.mock.method(AgentContextRecovery.prototype, "activate", () => {
      assert.equal(activity.at(-1), "ready-finished");
      activity.push("activated");
    });
    const info = Logger.prototype.info;
    t.mock.method(Logger.prototype, "info", function (this: Logger, input: Parameters<Logger["info"]>[0]) {
      if (input.event === "run_ready") throw failure;
      return info.call(this, input);
    });
    t.mock.method(Logger.prototype, "error", () => { throw new Error("failure logger unavailable"); });

    await assert.rejects(resumeRun(fixture.options), (error) => error === failure);

    assert.equal(activity.at(-1), "agents-stopped");
    assert.equal(activity.includes("activated"), failurePoint === "ready-log");
    assert.equal(existsSync(join(fixture.journalRoot, ".scout.lock")), false);
    assert.throws(() => currentRunScope(), /No active Scout run scope/);
  });
}

test("RestoreWorkflowStage leaves a completed resume empty without replaying its historical inputs", async (t) => {
  const fixture = await createFixture(t);
  fixture.writeWorkflow(fixture.runId);
  const thread = {
    agentId: "coordinator", role: "coordinator", phases: ["research"],
    contextBundleId: "context-original", threadId: "thread-original",
    createdAt: fixture.createdAt, status: "active",
    startInput: { cwd: fixture.root, approvalPolicy: "never", permissions: "scout-coordinator", ephemeral: false },
    startResponse: {},
  } satisfies AgentThreadSnapshot;
  const restartedThread = { ...thread, threadId: "thread-restarted" };
  const journal = Journal.open({
    journalId: "completed-resume", path: fixture.journalPath,
    lockPath: join(fixture.journalRoot, ".scout.lock"),
  });
  try {
    journal.append({ id: "thread", key: AgentEvents.thread.started, payload: thread, occurredAt: fixture.createdAt });
    journal.append({
      id: "restart", key: AgentEvents.thread.restarted,
      payload: { previousThreadId: thread.threadId, newThread: restartedThread,
        reason: "missing_rollout_without_recoverable_work", restartedAt: fixture.createdAt }, occurredAt: fixture.createdAt,
    });
    journal.append({
      id: "old-user-input", key: SystemEvents.interaction.userMessageSubmitted,
      payload: { messageId: "old-message", text: "next user work", attachment: "old work", submittedAt: fixture.createdAt },
      occurredAt: fixture.createdAt,
    });
    journal.append({
      id: "old-message", key: AgentEvents.message.queued,
      payload: { agentId: "coordinator", messageId: "old-message", body: "old work", queuedAt: fixture.createdAt },
      occurredAt: fixture.createdAt,
    });
    journal.append({
      id: "raw-only-input", key: SystemEvents.interaction.userMessageSubmitted,
      payload: { messageId: "raw-only-message", text: "not queued yet", attachment: "raw-only work", submittedAt: fixture.createdAt },
      occurredAt: fixture.createdAt,
    });
    const terminal = createTestGraph(fixture.graphData).advance("error");
    assert.equal(terminal.cycleCompleted, true);
    journal.append({
      id: "terminal", key: WorkflowEvents.workflow.advanced,
      payload: { ...terminal, outcome: "error", advancedAt: fixture.createdAt }, occurredAt: fixture.createdAt,
    });
    journal.append({
      id: "completed", key: WorkflowEvents.workflow.completed,
      payload: { completedAt: fixture.createdAt }, occurredAt: fixture.createdAt,
    });
  } finally {
    journal.close();
  }
  const before = readFileSync(fixture.journalPath, "utf8");
  const manifestBefore = readFileSync(fixture.manifestStore.path, "utf8");
  const stopBeforeExternalClients = new Error("next Workflow ready before clients");
  let reachedWorkflow = false;
  mockAfterRecovery(t, async () => {
    reachedWorkflow = true;
    const scope = currentRunScope();
    assert.equal(scope.domainRegistry.list().length, 0);
    assert.equal(scope.workflow.snapshot(), undefined);
    assert.doesNotThrow(() => scope.workflow.assertAcceptingInput());
    assert.deepEqual(scope.workflow.readEvents(), []);
    assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
    assert.equal(readFileSync(fixture.journalPath, "utf8"), before);
    throw stopBeforeExternalClients;
  });
  await assert.rejects(resumeRun(fixture.options), (error) => error === stopBeforeExternalClients);
  assert.equal(reachedWorkflow, true);
  assert.equal(readFileSync(fixture.journalPath, "utf8"), before);
  assert.equal(readFileSync(fixture.manifestStore.path, "utf8"), manifestBefore);
  assert.deepEqual(fixture.benchmarks.read(), {
    currentWorkflow: "workflow-001", lastWorkflow: "workflow-001",
    lastRun: "workflow-001", lastSuccess: "workflow-001",
  });
});

test("resume retains a settling Workflow together with its bound Task and pending non-user message", async (t) => {
  const fixture = await createFixture(t);
  fixture.writeWorkflow(fixture.runId);
  const task: AgentTaskState = {
    type: "local_agent", taskId: "pending-task", taskSequence: 1,
    agentId: "executor", role: "executor", phase: "execute",
    description: "finish existing work", initialPrompt: "finish existing work",
    status: AgentTaskStatuses.Running, isBackgrounded: true,
    createdAt: fixture.createdAt, updatedAt: fixture.createdAt,
    stepIds: [], dispositions: [],
  };
  const message = {
    agentId: "coordinator", messageId: "worker-message", body: "pending worker result", queuedAt: fixture.createdAt,
  };
  const journal = Journal.open({
    journalId: "settling-resume", path: fixture.journalPath,
    lockPath: join(fixture.journalRoot, ".scout.lock"),
  });
  try {
    journal.append({ id: "assigned", key: AgentEvents.task.assigned, payload: task, occurredAt: fixture.createdAt });
    journal.append({ id: "worker-message", key: AgentEvents.message.queued, payload: message, occurredAt: fixture.createdAt });
    const terminal = createTestGraph(fixture.graphData).advance("error");
    assert.equal(terminal.cycleCompleted, true);
    journal.append({
      id: "terminal", key: WorkflowEvents.workflow.advanced,
      payload: { ...terminal, outcome: "error", advancedAt: fixture.createdAt }, occurredAt: fixture.createdAt,
    });
  } finally {
    journal.close();
  }
  const before = readFileSync(fixture.journalPath, "utf8");
  const linksBefore = fixture.benchmarks.read();
  const stop = new Error("settling Workflow restored before clients");
  const clients = mockOwnerRestore(t, async () => {
    const workflow = currentRunScope().workflow;
    assert.equal(workflow.snapshot()?.workflowId, "workflow-001");
    assert.equal(workflow.snapshot()?.status, "settling");
    const projection = projectAgentWorkflow(workflow.readEvents(), "coordinator");
    assert.equal(projection.workflowStatus, "settling");
    assert.deepEqual(projection.tasks, [task]);
    assert.deepEqual(projection.pendingMessages, [message]);
    throw stop;
  });
  await assert.rejects(resumeRun(fixture.options), (error) => error === stop);
  assert.equal(clients.mock.callCount(), 1);
  assert.equal(readFileSync(fixture.journalPath, "utf8"), before);
  assert.deepEqual(fixture.benchmarks.read(), linksBefore);
  assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
});

for (const pending of ["task", "message", "turn", "running-step", "interrupted-step"] as const) {
  test(`resume rejects a completed Workflow with an unfinished ${pending} without changing its journal or pointers`, async (t) => {
    const fixture = await createFixture(t);
    fixture.writeWorkflow(fixture.runId);
    const journal = Journal.open({
      journalId: "invalid-completed-resume", path: fixture.journalPath,
      lockPath: join(fixture.journalRoot, ".scout.lock"),
    });
    let expected: RegExp;
    try {
      if (pending === "task") {
        journal.append({
          id: "task", key: AgentEvents.task.assigned,
          payload: {
            type: "local_agent", taskId: "pending-task", taskSequence: 1,
            agentId: "executor", role: "executor", phase: "execute",
            description: "pending task", initialPrompt: "pending task",
            status: AgentTaskStatuses.Queued, isBackgrounded: true,
            createdAt: fixture.createdAt, updatedAt: fixture.createdAt, stepIds: [], dispositions: [],
          }, occurredAt: fixture.createdAt,
        });
        expected = /unfinished Task pending-task/;
      } else if (pending === "message") {
        journal.append({
          id: "message", key: AgentEvents.message.queued,
          payload: { agentId: "coordinator", messageId: "worker-message", body: "worker result", queuedAt: fixture.createdAt },
          occurredAt: fixture.createdAt,
        });
        expected = /pending Agent messages/;
      } else if (pending === "turn") {
        journal.append({
          id: "turn", key: AgentEvents.turn.started,
          payload: { invocationId: "turn-1", agentId: "executor", role: "executor", threadId: "thread-1", prompt: "finish", startedAt: fixture.createdAt },
          occurredAt: fixture.createdAt,
        });
        expected = /unfinished Worker turn/;
      } else {
        const interrupted = pending === "interrupted-step";
        journal.append({
          id: "step", key: interrupted ? AgentEvents.step.interrupted : AgentEvents.step.started,
          payload: {
            stepId: "step-1", agentId: interrupted ? "coordinator" : "executor", status: interrupted ? "interrupted" : "running",
            prompt: "finish", toolCallIds: [], humanInputReferences: [],
            startedAt: fixture.createdAt, updatedAt: fixture.createdAt,
          }, occurredAt: fixture.createdAt,
        });
        expected = interrupted ? /completed Workflow reached clients/ : /running Worker step/;
      }
      const terminal = createTestGraph(fixture.graphData).advance("error");
      journal.append({
        id: "terminal", key: WorkflowEvents.workflow.advanced,
        payload: { ...terminal, outcome: "error", advancedAt: fixture.createdAt }, occurredAt: fixture.createdAt,
      });
      journal.append({
        id: "completed", key: WorkflowEvents.workflow.completed,
        payload: { completedAt: fixture.createdAt }, occurredAt: fixture.createdAt,
      });
    } finally {
      journal.close();
    }
    const before = readFileSync(fixture.journalPath, "utf8");
    const linksBefore = readFileSync(fixture.benchmarks.path, "utf8");
    const clients = pending === "interrupted-step"
      ? mockAfterRecovery(t, async () => {
        assert.equal(currentRunScope().workflow.snapshot(), undefined);
        throw new Error("completed Workflow reached clients");
      })
      : t.mock.method(ResumeClientsStage.prototype, "start");
    await assert.rejects(resumeRun(fixture.options), expected);
    assert.equal(clients.mock.callCount(), pending === "interrupted-step" ? 1 : 0);
    assert.equal(readFileSync(fixture.journalPath, "utf8"), before);
    assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), linksBefore);
    assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
    assert.equal(existsSync(join(fixture.journalRoot, ".scout.lock")), false);
    assert.equal(existsSync(join(fixture.runRoot, ".workflow.lock")), false);
  });
}

for (const scenario of [
  { name: "matching-rbt", persisted: "rbt", selected: "rbt", matches: true },
  { name: "matching-validation", persisted: "validation", selected: "validation", matches: true },
  { name: "changed-to-validation", persisted: "rbt", selected: "validation", matches: false },
  { name: "changed-to-rbt", persisted: "validation", selected: "rbt", matches: false },
]) {
  test(`resume checks the business Domain selection: ${scenario.name}`, async (t) => {
    const fixture = await createFixture(t, scenario.persisted);
    fixture.writeWorkflow(fixture.runId);
    const profilePath = join(fixture.root, "assets", "scout", "workflows", "rbt.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
    writeFileSync(profilePath, JSON.stringify({ ...profile, domain: scenario.selected }));
    const before = readFileSync(fixture.journalPath, "utf8");
    const stop = new Error("matching Domain selection reached clients");
    const clients = mockOwnerRestore(t, async () => {
      assert.deepEqual(currentRunScope().workflow.graph.snapshot().domain, scenario.persisted);
      throw stop;
    });
    if (scenario.matches) {
      await assert.rejects(resumeRun(fixture.options), (error) => error === stop);
    } else {
      await assert.rejects(resumeRun(fixture.options), /Cannot resume run-requested with domain.*persisted GraphData requires/);
    }
    assert.equal(clients.mock.callCount(), scenario.matches ? 1 : 0);
    assert.equal(readFileSync(fixture.journalPath, "utf8"), before);
    assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
  });
}

for (const missing of ["directory", "file"] as const) {
  test(`resume stays empty in the same Run when the benchmark target ${missing} is missing`, async (t) => {
    const fixture = await createFixture(t);
    const abandonedDomainPath = join(fixture.journalRoot, "rbt.journal");
    if (missing === "directory") rmSync(join(fixture.runRoot, "workflows", "workflow-001"), { recursive: true });
    if (missing === "file") {
      mkdirSync(fixture.journalRoot, { recursive: true });
      writeFileSync(abandonedDomainPath, "retained domain evidence\n", "utf8");
    }
    const manifestBefore = readFileSync(fixture.manifestStore.path, "utf8");
    const stopBeforeExternalClients = new Error("stop before external clients");
    let reachedWorkflow = false;
    mockAfterRecovery(t, async () => {
      reachedWorkflow = true;
      const scope = currentRunScope();
      assert.equal(scope.runId, fixture.runId);
      assert.equal(scope.runRoot, fixture.runRoot);
      assert.equal(scope.workflow.snapshot(), undefined);
      assert.deepEqual(scope.workflow.readEvents(), []);
      assert.deepEqual(scope.workflow.graph.snapshot(), fixture.graphData);
      assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
      assert.equal(fixture.disclosures.length, 1, "warning precedes service startup");
      assert.equal(fixture.disclosures[0]!.level, "warn");
      assert.equal(readFileSync(fixture.manifestStore.path, "utf8"), manifestBefore);
      throw stopBeforeExternalClients;
    });

    await assert.rejects(resumeRun(fixture.options), (error) => error === stopBeforeExternalClients);

    assert.equal(reachedWorkflow, true);
    assert.equal(readFileSync(fixture.manifestStore.path, "utf8"), manifestBefore);
    assert.deepEqual(fixture.benchmarks.read(), {
      currentWorkflow: "workflow-001",
      lastWorkflow: "workflow-001",
      lastRun: "workflow-001",
      lastSuccess: "workflow-001",
    });
    assert.equal(fixture.disclosures.length, 1);
    assert.match(fixture.disclosures[0]!.message, /journal for workflow-001 is missing; Run run-requested will wait without an active Workflow/);
    assert.deepEqual(fixture.disclosures[0]!.data, {
      runId: fixture.runId,
      missingWorkflowId: "workflow-001",
      missingJournalPath: missing === "file" ? fixture.journalPath : undefined,
    });
    if (missing === "file") {
      assert.equal(readFileSync(abandonedDomainPath, "utf8"), "retained domain evidence\n");
    }
  });
}

for (const change of ["journal-reappeared", "permalink-changed"] as const) {
  test(`missing-journal resume rejects ${change} after taking the runtime lock without overwriting the repaired Workflow`, async (t) => {
    const fixture = await createFixture(t);
    const manifestBefore = readFileSync(fixture.manifestStore.path, "utf8");
    const acquire = Benchmarks.prototype.acquire;
    let changed = false;
    let repairedPath = "";
    let repairedContents = "";
    let repairedLinks = "";
    t.mock.method(Benchmarks.prototype, "acquire", function (this: Benchmarks) {
      if (!changed) {
        changed = true;
        // A competing runtime repairs the selection after ENOENT was observed,
        // and releases the root before the waiting resume obtains its lock.
        const competing = new ScoutBenchmarks(new Benchmarks(fixture.runRoot));
        acquire.call(competing.benchmarks);
        try {
          const target = change === "permalink-changed"
            ? competing.prepareNext()
            : { workflowId: "workflow-001", journalRoot: fixture.journalRoot };
          repairedPath = join(target.journalRoot, "scout.journal");
          const repaired = Journal.create({
            journalId: "repaired-workflow", path: repairedPath,
            lockPath: join(target.journalRoot, ".scout.lock"),
          });
          try {
            repaired.append({
              id: "run-created", key: RunEvents.run.created,
              payload: { runId: fixture.runId, scoutRoot: fixture.root, createdAt: fixture.createdAt },
              occurredAt: fixture.createdAt,
            });
            repaired.append({
              id: "workflow-initialized", key: WorkflowEvents.workflow.initialized,
              payload: { state: fixture.graphData, initializedAt: fixture.createdAt },
              occurredAt: fixture.createdAt,
            });
          } finally {
            repaired.close();
          }
          if (change === "permalink-changed") competing.recordStarted(target.workflowId);
          repairedContents = readFileSync(repairedPath, "utf8");
          repairedLinks = readFileSync(fixture.benchmarks.path, "utf8");
        } finally {
          competing.benchmarks.release();
        }
      }
      acquire.call(this);
    });
    const clients = t.mock.method(ResumeClientsStage.prototype, "start", async () => {
      assert.fail("A stale missing-journal decision cannot start clients.");
    });

    await assert.rejects(resumeRun(fixture.options), change === "journal-reappeared"
      ? /missing journal reappeared.*retry resume/
      : /benchmark selection changed.*retry resume/);

    assert.equal(changed, true);
    assert.equal(clients.mock.callCount(), 0);
    assert.equal(readFileSync(repairedPath, "utf8"), repairedContents);
    assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), repairedLinks);
    assert.equal(readFileSync(fixture.manifestStore.path, "utf8"), manifestBefore);
    assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-003")), false);
    if (change === "journal-reappeared") {
      assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
    }
    assert.equal(existsSync(join(fixture.runRoot, ".workflow.lock")), false);
  });
}

test("missing-journal resume preserves non-ENOENT failures found under its runtime lock", async (t) => {
  const fixture = await createFixture(t);
  const linksBefore = readFileSync(fixture.benchmarks.path, "utf8");
  const acquire = Benchmarks.prototype.acquire;
  t.mock.method(Benchmarks.prototype, "acquire", function (this: Benchmarks) {
    rmSync(fixture.journalRoot, { recursive: true });
    writeFileSync(fixture.journalRoot, "the Workflow directory is no longer a directory");
    acquire.call(this);
  });
  const clients = t.mock.method(ResumeClientsStage.prototype, "start", async () => {
    assert.fail("A journal I/O error cannot start clients.");
  });

  await assert.rejects(resumeRun(fixture.options), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ENOTDIR"
  );
  assert.equal(clients.mock.callCount(), 0);
  assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), linksBefore);
  assert.equal(readFileSync(fixture.journalRoot, "utf8"), "the Workflow directory is no longer a directory");
  assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
  assert.equal(existsSync(join(fixture.runRoot, ".workflow.lock")), false);
});

test("resume does not silently start a new Workflow when its missing-journal warning cannot be disclosed", async (t) => {
  const fixture = await createFixture(t);
  const failure = new Error("interaction is unavailable");
  t.mock.method(fixture.options.interactionPort, "disclose", async () => {
    throw failure;
  });
  const benchmarksBefore = readFileSync(fixture.benchmarks.path, "utf8");
  const clients = t.mock.method(ResumeClientsStage.prototype, "start");

  await assert.rejects(resumeRun(fixture.options), (error) => error === failure);

  assert.equal(clients.mock.callCount(), 0);
  assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), benchmarksBefore);
  assert.equal(existsSync(join(fixture.runRoot, "logs")), false);
  assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
});

for (const failure of ["empty", "malformed", "io-error", "empty-permalink"] as const) {
  test(`resume does not start a new Workflow for an ${failure} journal selection`, async (t) => {
    const fixture = await createFixture(t);
    mkdirSync(fixture.journalRoot, { recursive: true });
    let expected: RegExp;
    if (failure === "empty-permalink") {
      writeFileSync(fixture.benchmarks.path, JSON.stringify({
        scout: { ...fixture.benchmarks.read(), currentWorkflow: "" },
      }), "utf8");
      expected = /Workflow benchmark currentWorkflow must not be empty/;
    } else if (failure === "io-error") {
      mkdirSync(fixture.journalPath);
      expected = /EISDIR/;
    } else {
      writeFileSync(fixture.journalPath, failure === "empty" ? "" : "invalid json\n", "utf8");
      expected = failure === "empty" ? /missing run.created/ : /Invalid journal JSON/;
    }
    const benchmarksBefore = readFileSync(fixture.benchmarks.path, "utf8");
    const clients = t.mock.method(ResumeClientsStage.prototype, "start");

    await assert.rejects(resumeRun(fixture.options), expected);

    assert.equal(clients.mock.callCount(), 0);
    assert.equal(readFileSync(fixture.benchmarks.path, "utf8"), benchmarksBefore);
    assert.equal(existsSync(join(fixture.runRoot, "logs")), false);
    assert.equal(existsSync(join(fixture.runRoot, "workflows", "workflow-002")), false);
    assert.deepEqual(fixture.disclosures, []);
  });
}

function createFixture(t: TestContext, domain: string = "rbt", installEnvironment = false) {
  if (!installEnvironment) {
    // Exercise the real Workflow and owner recovery driver, without external clients.
    const serial = RunStageExecutor.prototype.registerSerial;
    const parallel = RunStageExecutor.prototype.registerParallel;
    t.mock.method(RunStageExecutor.prototype, "registerSerial", function (this: RunStageExecutor, ...stages: RunStage[]) {
      serial.apply(this, stages.filter((stage) => ["run_scope", "workflow", "restore_workflow"].includes(stage.id)));
    });
    t.mock.method(RunStageExecutor.prototype, "registerParallel", function (this: RunStageExecutor, ...stages: RunStage[]) {
      parallel.apply(this, stages.filter((stage) => stage.id === "orchestrator"));
    });
    t.mock.method(AgentEntityRecovery.prototype, "restore", async () => undefined);
    t.mock.method(AgentEntityRecovery.prototype, "stop", async () => undefined);
    t.mock.method(AgentTaskRecovery.prototype, "restore", async () => undefined);
    t.mock.method(AgentContextRecovery.prototype, "restore", async () => undefined);
    t.mock.method(AgentContextRecovery.prototype, "activate", () => undefined);
  }
  const root = mkdtempSync(join(tmpdir(), "scout-resume-workflow-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(process.cwd(), "assets", "scout"), join(root, "assets", "scout"), {
    recursive: true,
  });
  const profilePath = join(root, "assets", "scout", "workflows", "rbt.json");
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
  writeFileSync(profilePath, JSON.stringify({ ...profile, domain }));
  const runId = "run-requested";
  const runRoot = join(root, "run", runId);
  const createdAt = "2026-07-22T00:00:00.000Z";
  const manifestStore = new RunManifestStore(runRoot);
  manifestStore.create({ runId, scoutRoot: root, createdAt, checkpointSeq: 27 });
  // Workflow-selection fixtures represent an already indexed environment; tests of
  // interrupted initialization explicitly omit this index.
  manifestStore.update((manifest) => ({ ...manifest, agents: {} }));
  const benchmarks = new ScoutBenchmarks(new Benchmarks(runRoot));
  benchmarks.benchmarks.acquire();
  try {
    benchmarks.prepareNext();
    benchmarks.recordStarted("workflow-001");
    benchmarks.recordSuccess("workflow-001");
  } finally {
    benchmarks.benchmarks.release();
  }
  const journalRoot = join(runRoot, "workflows", "workflow-001", "journal");
  const journalPath = join(journalRoot, "scout.journal");
  const graphData = new Workflow(new AssetStore().buildWorkflow(root, "rbt")).graph.snapshot();
  const disclosures: RuntimeDisclosureEvent[] = [];
  const interactionPort = new NoopRuntimeInteractionPort();
  t.mock.method(interactionPort, "disclose", async (event: RuntimeDisclosureEvent) => {
    disclosures.push(event);
  });
  return {
    root,
    runId,
    runRoot,
    createdAt,
    manifestStore,
    benchmarks,
    journalRoot,
    journalPath,
    graphData,
    disclosures,
    options: { cwd: root, run: runId, interactionPort },
    writeWorkflow(journalRunId?: string) {
      const journal = Journal.create({
        journalId: "resume-selection-test",
        path: journalPath,
        lockPath: join(journalRoot, ".scout.lock"),
      });
      try {
        if (journalRunId !== undefined) {
          journal.append({
            id: "run-created",
            key: RunEvents.run.created,
            payload: { runId: journalRunId, scoutRoot: root, createdAt },
            occurredAt: createdAt,
          });
        }
        journal.append({
          id: "workflow-initialized",
          key: WorkflowEvents.workflow.initialized,
          payload: { state: graphData, initializedAt: createdAt },
          occurredAt: createdAt,
        });
      } finally {
        journal.close();
      }
    },
  };
}

/** Observe this owner's restored facts before subsequent owners run. */
function mockOwnerRestore(t: TestContext, inspect: () => Promise<void>) {
  const restore = Workflow.prototype.restore;
  return t.mock.method(Workflow.prototype, "restore", function (this: Workflow, ...args: Parameters<Workflow["restore"]>) {
    restore.apply(this, args);
    return inspect();
  });
}

/** Observe the final active/blank state after the real recovery transition. */
function mockAfterRecovery(t: TestContext, inspect: () => Promise<void>) {
  const start = RestoreWorkflowStage.prototype.start;
  return t.mock.method(RestoreWorkflowStage.prototype, "start", async function (this: RestoreWorkflowStage) {
    await start.call(this);
    await inspect();
  });
}

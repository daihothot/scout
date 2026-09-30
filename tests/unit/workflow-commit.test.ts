import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { agent } from "../../src/agent/context/agent-attachments.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import { EventSubscriptionPriorities, InMemoryEventBus, type EventType, type ScoutEvent } from "../../src/core/events/index.js";
import { Journal, readJournalEvents } from "../../src/core/journal/index.js";
import { Workflow, WorkflowEvents, projectWorkflowState, type WorkflowResumeInput } from "../../src/core/workflow/index.js";
import type { AgentTaskState } from "../../src/agent/task/types.js";
import { ScoutBenchmarks } from "../../src/core/benchmarks/index.js";
import { Benchmarks } from "../../src/core/benchmarks/index.js";
import { BaseDomain, DomainAgentBackend, ScoutDomainId } from "../../src/domain/index.js";
import type { RecordWorkflowChange } from "../../src/core/record/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { StartWorkflowStage } from "../../src/run/startup/stages/start-workflow-stage.js";
import { projectGraphState, projectRun } from "../../src/run/resume/projection/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import { createTestRunPersistence, installTestRunScope, createTestWorkflowAsset } from "../helpers/run-persistence.js";

test("Workflow startup isolates different Runs in the same Scout repository", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-workflow-start-isolation-"));
  const firstRoot = join(root, "run", "run-first");
  const secondRoot = join(root, "run", "run-second");
  const first = createTestRunPersistence(t, "run-first", root, new InMemoryEventBus(), firstRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(first.workflow.journalPath, join(firstRoot, "workflows", "workflow-001", "journal", "scout.journal"));
  const firstContents = readFileSync(first.workflow.journalPath, "utf8");
  const firstLinks = readFileSync(join(firstRoot, "benchmarks.json"), "utf8");
  const second = createTestRunPersistence(t, "run-second", root, new InMemoryEventBus(), secondRoot);
  assert.equal(second.workflow.journalPath, join(secondRoot, "workflows", "workflow-001", "journal", "scout.journal"));
  assert.equal(readFileSync(first.workflow.journalPath, "utf8"), firstContents);
  assert.equal(readFileSync(join(firstRoot, "benchmarks.json"), "utf8"), firstLinks);
  assert.equal(existsSync(join(firstRoot, ".workflow.lock")), true);
  assert.equal(existsSync(join(secondRoot, ".workflow.lock")), true);
  await second.workflow.stop();
  assert.equal(existsSync(join(firstRoot, ".workflow.lock")), true);
  assert.equal(existsSync(join(secondRoot, ".workflow.lock")), false);
  assert.equal(existsSync(join(root, "run", "benchmarks.json")), false);
  assert.equal(existsSync(join(root, "run", "workflow-001")), false);
  assert.equal(Object.hasOwn(first.manifestStore.read(), "workflowId"), false);
  assert.equal(Object.hasOwn(second.manifestStore.read(), "workflowId"), false);
});

test("Terminal advance waits for accepted outcome consumers before closing Workflow records", async (t) => {
  const { workflow, eventBus } = await fixture(t);
  const journalRoot = workflow.journalRoot;
  const path = workflow.journalPath;
  const at = new Date().toISOString();
  const task: AgentTaskState = { type: "local_agent", taskId: "final-task", taskSequence: 1,
    agentId: "researcher", role: "researcher", phase: "research", description: "Final work", initialPrompt: "Work",
    status: "done", isBackgrounded: true, stepIds: [], dispositions: [], createdAt: at, updatedAt: at };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const consuming = new Promise<void>((resolve) => { entered = resolve; });
  eventBus.subscribe(AgentEvents.task.outcomeSubmitted, async () => {
    entered();
    await gate;
    await eventBus.publishAndWait(AgentEvents.task.released, task);
  });
  const outcome = eventBus.publishAndWait(AgentEvents.task.outcomeSubmitted, {
    task, stepId: "final-step", outcome: "Done", submittedAt: at,
  });
  await consuming;
  const finishing = workflow.advance("error");
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(workflow.snapshot()?.status, "active");
    assert.equal(workflow.graph.completedOutcome, undefined);
    assert.equal(workflow.readEvents().some((event) => WorkflowEvents.workflow.advanced.is(event)), false);
    assert.equal(workflow.readEvents().some((event) => WorkflowEvents.workflow.completed.is(event)), false);
    assert.equal(existsSync(join(journalRoot, ".scout.lock")), true);
    release();
    await Promise.all([outcome, finishing]);
    assert.equal(workflow.snapshot(), undefined);
    const events = readJournalEvents(path);
    assert.ok(events.find((event) => AgentEvents.task.released.is(event))!.seq
      < events.find((event) => WorkflowEvents.workflow.advanced.is(event))!.seq);
    assert.ok(events.find((event) => AgentEvents.task.released.is(event))!.seq
      < events.find((event) => WorkflowEvents.workflow.completed.is(event))!.seq);
    assert.equal(existsSync(join(journalRoot, ".scout.lock")), false);
  } finally {
    release();
    await Promise.allSettled([outcome, finishing]);
  }
});

test("Nonterminal advance waits for outcome consumers before committing and rejects overlapping advances", async (t) => {
  const { workflow, eventBus } = await fixture(t);
  const beforeGraph = workflow.graph.snapshot();
  const at = new Date().toISOString();
  const task: AgentTaskState = { type: "local_agent", taskId: "phase-task", taskSequence: 1,
    agentId: "researcher", role: "researcher", phase: "research", description: "Phase work", initialPrompt: "Work",
    status: "done", isBackgrounded: true, stepIds: [], dispositions: [], createdAt: at, updatedAt: at };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const consuming = new Promise<void>((resolve) => { entered = resolve; });
  eventBus.subscribe(AgentEvents.task.outcomeSubmitted, async () => { entered(); await gate; });
  const outcome = eventBus.publishAndWait(AgentEvents.task.outcomeSubmitted, {
    task, stepId: "phase-step", outcome: "Done", submittedAt: at,
  });
  await consuming;
  const beforeWorkflow = workflow.snapshot();
  const advancing = workflow.advance("completed");
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(workflow.graph.snapshot(), beforeGraph);
    assert.deepEqual(workflow.snapshot(), beforeWorkflow);
    assert.equal(workflow.readEvents().some((event) => WorkflowEvents.workflow.advanced.is(event)), false);
    await assert.rejects(workflow.advance("error"), /already advancing/);
    release();
    const result = await advancing;
    await outcome;
    assert.equal(result.status, "advanced");
    assert.equal(result.result.cycleCompleted, false);
    assert.equal(workflow.graph.snapshot().currentPhase, "research-reviewer");
    assert.equal(workflow.readEvents().filter((event) => WorkflowEvents.workflow.advanced.is(event)).length, 1);
  } finally {
    release();
    await Promise.allSettled([outcome, advancing]);
  }
});

for (const outcome of ["completed", "error"] as const) {
  test(`Workflow ${outcome} waits for its own advanced event before returning or exiting`, async (t) => {
    const { workflow, eventBus } = await fixture(t);
    const journalPath = workflow.journalPath;
    let entered!: () => void;
    const consuming = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    eventBus.subscribe(WorkflowEvents.workflow.advanced, async () => { entered(); await gate; });
    let returned = false;
    const advancing = workflow.advance(outcome).then((result) => { returned = true; return result; });
    try {
      await consuming;
      assert.equal(returned, false);
      assert.equal(workflow.snapshot()?.status, outcome === "error" ? "settling" : "active");
      assert.equal(workflow.graph.completedOutcome, outcome === "error" ? "error" : undefined);
      assert.equal(workflow.readEvents().some((event) => WorkflowEvents.workflow.completed.is(event)), false);
      assert.equal(existsSync(join(workflow.journalRoot, ".scout.lock")), true);
      release();
      const result = await advancing;
      assert.equal(result.status, "advanced");
      assert.equal(result.result.cycleCompleted, outcome === "error");
      assert.equal(readJournalEvents(journalPath).filter((event) => WorkflowEvents.workflow.completed.is(event)).length,
        outcome === "error" ? 1 : 0);
    } finally {
      release();
      await Promise.allSettled([advancing]);
    }
  });

  test(`An advanced observer failure cannot undo the committed ${outcome} decision`, async (t) => {
    const { workflow, eventBus } = await fixture(t);
    const journalPath = workflow.journalPath;
    eventBus.subscribe(WorkflowEvents.workflow.advanced, async () => { throw new Error("Observer unavailable"); });
    const result = await workflow.advance(outcome);
    assert.equal(result.status, "advanced");
    assert.equal(result.result.cycleCompleted, outcome === "error");
    const events = readJournalEvents(journalPath);
    assert.equal(events.filter((event) => WorkflowEvents.workflow.advanced.is(event)).length, 1);
    assert.equal(events.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, outcome === "error" ? 1 : 0);
  });
}

test("Stopping waits for pre-commit consumers and prevents the waiting advance from committing", async (t) => {
  const { workflow, eventBus } = await fixture(t);
  const beforeGraph = workflow.graph.snapshot();
  const journalPath = workflow.journalPath;
  const at = new Date().toISOString();
  const task: AgentTaskState = { type: "local_agent", taskId: "stopping-task", taskSequence: 1,
    agentId: "researcher", role: "researcher", phase: "research", description: "Finishing work", initialPrompt: "Work",
    status: "done", isBackgrounded: true, stepIds: [], dispositions: [], createdAt: at, updatedAt: at };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const consuming = new Promise<void>((resolve) => { entered = resolve; });
  eventBus.subscribe(AgentEvents.task.outcomeSubmitted, async () => { entered(); await gate; });
  const outcome = eventBus.publishAndWait(AgentEvents.task.outcomeSubmitted, {
    task, stepId: "stopping-step", outcome: "Done", submittedAt: at,
  });
  await consuming;
  const advancing = workflow.advance("completed");
  const rejected = assert.rejects(advancing, /not accepting Graph changes/);
  let stopped = false;
  const stopping = workflow.stop().then(() => { stopped = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(existsSync(join(workflow.journalRoot, ".scout.lock")), true);
    release();
    await Promise.all([outcome, rejected, stopping]);
    assert.deepEqual(workflow.graph.snapshot(), beforeGraph);
    assert.equal(readJournalEvents(journalPath).some((event) => WorkflowEvents.workflow.advanced.is(event)), false);
  } finally {
    release();
    await Promise.allSettled([outcome, rejected, stopping]);
  }
});

test("Stopping after Graph commit waits for advanced consumers and preserves terminal completion", async (t) => {
  const { workflow, eventBus } = await fixture(t);
  const journalPath = workflow.journalPath;
  const journalRoot = workflow.journalRoot;
  let entered!: () => void;
  const consuming = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  eventBus.subscribe(WorkflowEvents.workflow.advanced, async () => { entered(); await gate; });
  const advancing = workflow.advance("error");
  await consuming;
  let stopped = false;
  const stopping = workflow.stop().then(() => { stopped = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(workflow.snapshot()?.status, "settling");
    assert.equal(existsSync(join(journalRoot, ".scout.lock")), true);
    release();
    const result = await advancing;
    await stopping;
    assert.equal(result.status, "advanced");
    assert.equal(result.result.cycleCompleted, true);
    assert.equal(workflow.graph.completedOutcome, "error");
    const events = readJournalEvents(journalPath);
    assert.equal(events.filter((event) => WorkflowEvents.workflow.advanced.is(event)).length, 1);
    assert.equal(events.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
    assert.equal(existsSync(join(journalRoot, ".scout.lock")), false);
  } finally {
    release();
    await Promise.allSettled([advancing, stopping]);
  }
});

test("Terminal recovery finishes runtime transactions without a Coordinator Turn or a new Workflow", async (t) => {
  const { workflow, scope, base, eventBus, benchmarks } = await fixture(t);
  const path = workflow.journalPath;
  const journalRoot = workflow.journalRoot;
  const at = new Date().toISOString();
  await eventBus.publishAndWait(AgentEvents.turn.started, {
    invocationId: "interrupted-coordinator", agentId: "coordinator", role: "coordinator", threadId: "thread-coordinator", prompt: "Finish", startedAt: at,
  });
  const terminal = workflow.graph.previewAdvance("error");
  workflow.scoutRecordObject.write({ id: "terminal-before-crash", key: WorkflowEvents.workflow.advanced,
    payload: { ...terminal, outcome: "error", advancedAt: at }, occurredAt: at });
  const events = workflow.readEvents();
  const recovery: WorkflowResumeInput = { graphState: projectGraphState(events),
    workflowState: projectWorkflowState("workflow-001", events), journalRoot };
  base.close();
  await workflow.stop();
  const restored = new Workflow(createTestWorkflowAsset(recovery.graphState));
  scope.clearWorkflow(workflow); scope.setWorkflow(restored);
  try {
    await restored.start();
    restored.restore(recovery);
    base.start();
    let turns = 0;
    eventBus.subscribe(AgentEvents.turn.started, () => { turns += 1; });
    await eventBus.publishAndWait(RunEvents.runtime.ready, { mode: "resume", readyAt: at });
    assert.equal(turns, 0);
    assert.equal(restored.snapshot(), undefined);
    assert.equal(readJournalEvents(path).filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
    assert.equal(benchmarks.read()?.currentWorkflow, "workflow-001");
    assert.equal(existsSync(join(scope.runRoot, "workflows", "workflow-002")), false);
    assert.equal(existsSync(join(journalRoot, ".scout.lock")), false);
    assert.equal(existsSync(join(journalRoot, ".base.lock")), false);
  } finally {
    base.close();
    await restored.stop();
    scope.clearWorkflow(restored); scope.setWorkflow(workflow);
  }
});

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "scout-workflow-commit-"));
  const eventBus = new InMemoryEventBus();
  const persistence = createTestRunPersistence(t, "workflow-commit", root, eventBus, join(root, "run", "workflow-commit"));
  const scope = installTestRunScope(t, {
    runId: "workflow-commit", scoutRoot: root, eventBus,
    workflow: persistence.workflow, manifestStore: persistence.manifestStore,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start", attachedAt: new Date().toISOString(), processId: process.pid,
  });
  const workflow = scope.workflow;
  const base = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  const benchmarks = new ScoutBenchmarks(new Benchmarks(scope.runRoot));
  const submit = (text: string) => eventBus.publishAndWait(SystemEvents.interaction.userMessageSubmitted, {
    messageId: text, text, attachment: agent.turn.message(text), submittedAt: new Date().toISOString(),
  });
  const registerPreparation = (prepareWorkflow: () => Promise<Pick<RecordWorkflowChange, "commit" | "abort" | "releasePrevious">> | Pick<RecordWorkflowChange, "commit" | "abort" | "releasePrevious">) => {
    let change: Pick<RecordWorkflowChange, "commit" | "abort" | "releasePrevious"> | undefined;
    const options = { priority: EventSubscriptionPriorities.Critical };
    const unsubscribe = [
      eventBus.subscribe(WorkflowEvents.workflow.preparing, async () => { change = await prepareWorkflow(); }, options),
      eventBus.subscribe(WorkflowEvents.workflow.committing, () => { change?.commit(); }, options),
      eventBus.subscribe(WorkflowEvents.workflow.aborting, () => { change?.abort(); change = undefined; }, options),
      eventBus.subscribe(WorkflowEvents.workflow.releasingPrevious, () => { change?.releasePrevious(); change = undefined; }, options),
    ];
    scope.domainRegistry.register({
      description: { id: ScoutDomainId.Rbt, name: "Transition test Domain" },
      backend: new class extends DomainAgentBackend {
        override async handleDynamicToolCall() { return undefined; }
      }(),
      stop() { for (const stop of unsubscribe) stop(); },
    });
  };
  return { runRoot: scope.runRoot, eventBus, scope, workflow, base, benchmarks, submit, registerPreparation };
}

test("Workflow Graph preview is pure and a journal failure cannot advance live state", async (t) => {
  const { workflow, eventBus } = await fixture(t);
  const graph = workflow.graph.snapshot();
  const workflowState = workflow.snapshot()!;
  const seq = workflow.lastSeq;
  assert.equal(workflow.graph.previewAdvance("completed").state.currentPhase, "research-reviewer");
  assert.deepEqual(workflow.graph.snapshot(), graph);
  let broadcasts = 0;
  eventBus.subscribe(WorkflowEvents.workflow.advanced, () => { broadcasts += 1; });
  const original = Journal.prototype.append;
  const append = t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
    if (this.path === workflow.journalPath) throw new Error("journal unavailable");
    return original.call(this, event);
  });
  await assert.rejects(async () => await workflow.advance("completed"), /journal unavailable/);
  assert.equal(append.mock.callCount(), 2);
  assert.deepEqual(workflow.graph.snapshot(), graph);
  assert.deepEqual(workflow.snapshot(), workflowState);
  assert.equal(workflow.lastSeq, seq);
  assert.equal(broadcasts, 0);
  append.mock.restore();
  await workflow.advance("completed");
  await Promise.resolve();
  assert.equal(workflow.lastSeq, seq + 1);
  assert.equal(broadcasts, 1);
  assert.deepEqual(projectGraphState(workflow.readEvents()), workflow.graph.snapshot());
});

test("A success permalink failure is disclosed without undoing Graph completion or skipping release", async (t) => {
  const { workflow, benchmarks, eventBus } = await fixture(t);
  const path = workflow.journalPath;
  const journalRoot = workflow.journalRoot;
  await workflow.advance("completed");
  await workflow.advance("completed");
  await workflow.advance("completed");
  const priorLinks = benchmarks.read();
  let broadcasts = 0;
  const errors: unknown[] = [];
  eventBus.subscribe(SystemEvents.interaction.disclosureRequested, ({ payload }) => { errors.push(payload); });
  eventBus.subscribe(WorkflowEvents.workflow.advanced, () => { broadcasts += 1; });
  t.mock.method(ScoutBenchmarks.prototype, "recordSuccess", () => { throw new Error("benchmark unavailable"); });
  const terminalPhase = workflow.graph.snapshot().currentPhase;
  const advanced = await workflow.advance("completed");
  assert.equal(advanced.status, "advanced");
  assert.equal(advanced.result.cycleCompleted, true);
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(workflow.graph.completedOutcome, "completed");
  assert.equal(workflow.graph.snapshot().currentPhase, terminalPhase);
  const events = readJournalEvents(path);
  assert.equal(events.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
  assert.equal(projectWorkflowState("workflow-001", events).status, "completed");
  assert.deepEqual(projectGraphState(events), workflow.graph.snapshot());
  assert.equal(existsSync(join(journalRoot, ".scout.lock")), false);
  assert.equal(existsSync(join(journalRoot, ".base.lock")), false);
  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors), /benchmark unavailable/);
  assert.deepEqual(benchmarks.read(), priorLinks);
  await assert.rejects(workflow.advance("completed"), /Workflow is unavailable/);
  await Promise.resolve();
  assert.equal(workflow.snapshot(), undefined);
  assert.deepEqual(readJournalEvents(path), events);
  assert.deepEqual(benchmarks.read(), priorLinks);
  assert.equal(broadcasts, 1);
  const seq = workflow.lastSeq;
  await assert.rejects(async () => await workflow.advance("completed"), /Workflow is unavailable/);
  assert.equal(workflow.lastSeq, seq);
  await workflow.startWorkflow();
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
  assert.equal(workflow.graph.completedOutcome, undefined);
});

test("Completion recording failure preserves the Graph fact, releases resources and is recoverable", async (t) => {
  const { workflow, scope, base, eventBus } = await fixture(t);
  const path = workflow.journalPath;
  const journalRoot = workflow.journalRoot;
  const errors: unknown[] = [];
  eventBus.subscribe(SystemEvents.interaction.disclosureRequested, ({ payload }) => { errors.push(payload); });
  const original = Journal.prototype.append;
  const append = t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
    if (this.path === path && WorkflowEvents.workflow.completed.is(event)) throw new Error("completion write failed");
    return original.call(this, event);
  });
  const advanced = await workflow.advance("error");
  assert.equal(advanced.status, "advanced");
  assert.equal(advanced.result.cycleCompleted, true);
  assert.equal(workflow.graph.completedOutcome, "error");
  assert.equal(workflow.snapshot(), undefined);
  assert.match(JSON.stringify(errors), /completion write failed/);
  assert.equal(existsSync(join(journalRoot, ".scout.lock")), false);
  assert.equal(existsSync(join(journalRoot, ".base.lock")), false);
  const events = readJournalEvents(path);
  assert.equal(events.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 0);
  assert.equal(events.filter((event) => WorkflowEvents.workflow.advanced.is(event)).length, 1);
  append.mock.restore();

  await workflow.stop();
  base.close();
  const restored = new Workflow(createTestWorkflowAsset(projectGraphState(events)));
  scope.clearWorkflow(workflow); scope.setWorkflow(restored);
  try {
    await restored.start();
    restored.restore({ graphState: projectGraphState(events), workflowState: projectWorkflowState("workflow-001", events), journalRoot });
    assert.equal(restored.graph.completedOutcome, "error");
    base.start();
    await eventBus.publishAndWait(RunEvents.runtime.ready, { mode: "resume", readyAt: new Date().toISOString() });
    assert.equal(restored.snapshot(), undefined);
    assert.equal(readJournalEvents(path).filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
    assert.equal(readJournalEvents(path).filter((event) => WorkflowEvents.workflow.advanced.is(event)).length, 1);
  } finally {
    base.close(); await restored.stop();
    scope.clearWorkflow(restored); scope.setWorkflow(workflow);
  }
});

test("Workflow initializes Graph directly without duplicating the recorded entry baseline", async (t) => {
  const { workflow, eventBus } = await fixture(t);
  const workflowState = workflow.snapshot();
  const seq = workflow.lastSeq;
  let broadcasts = 0;
  eventBus.subscribe(WorkflowEvents.workflow.initialized, () => { broadcasts += 1; });
  t.mock.method(workflow.scoutRecordObject, "write", () => { throw new Error("initialization write failed"); });
  const initialize = t.mock.method(workflow.graph, "initializeGraph");
  assert.deepEqual(workflow.initialize(), workflow.graph.initialSnapshot());
  assert.equal(initialize.mock.callCount(), 1);
  assert.deepEqual(workflow.snapshot(), workflowState);
  assert.equal(workflow.lastSeq, seq);
  assert.equal(broadcasts, 0);
  assert.equal(workflow.readEvents().filter((event) => WorkflowEvents.workflow.initialized.is(event)).length, 1);
});

test("Workflow startup failure retains resource ownership when recording cleanup also fails", async (t) => {
  const { workflow, scope, runRoot, base } = await fixture(t);
  const created = workflow.readEvents().find((event) => RunEvents.run.created.is(event));
  assert.ok(created);
  const next = new Workflow(createTestWorkflowAsset(workflow.graph.snapshot()));
  await workflow.stop();
  base.close();
  scope.clearWorkflow(workflow);
  scope.setWorkflow(next);
  const writeFailure = new Error("initialization write failed");
  const closeFailure = new Error("cleanup failed");
  const write = t.mock.method(next.scoutRecordObject, "start", () => { throw writeFailure; });
  const stop = next.scoutRecordObject.stop.bind(next.scoutRecordObject);
  const close = t.mock.method(next.scoutRecordObject, "stop", () => { stop(); throw closeFailure; });
  try {
    await assert.rejects(next.start(), (error) => error instanceof AggregateError
      && error.errors.includes(writeFailure) && error.errors.includes(closeFailure));
    await assert.rejects(next.advance("completed"), /not accepting Graph changes/);
    assert.throws(() => new ScoutBenchmarks(new Benchmarks(runRoot)).benchmarks.acquire(), /already attached/);
  } finally {
    write.mock.restore();
    close.mock.restore();
    await next.stop();
    assert.equal(existsSync(join(runRoot, ".workflow.lock")), false);
    scope.clearWorkflow(next);
    scope.setWorkflow(workflow);
  }
});

test("Completed Workflow recovery stays empty and stopping never prepares another Workflow", async (t) => {
  const { workflow, scope, base, benchmarks } = await fixture(t);
  const previousPath = workflow.journalPath;
  const journalRoot = workflow.journalRoot;
  await workflow.advance("error");

  const events = readJournalEvents(previousPath);
  const links = benchmarks.read();
  const next = new Workflow(createTestWorkflowAsset(projectGraphState(events)));
  const nextRecovery = {
    graphState: projectGraphState(events),
    workflowState: projectWorkflowState("workflow-001", events), journalRoot
  };
  await workflow.stop();
  base.close();
  for (const domain of scope.domainRegistry.list()) scope.domainRegistry.unregister(domain);
  scope.clearWorkflow(workflow);
  scope.setWorkflow(next);
  const prepare = t.mock.method(next.scoutRecordObject, "prepareWorkflow");
  try {
    await next.start();
    next.restore(nextRecovery);
    assert.equal(next.snapshot(), undefined);
    assert.deepEqual(next.readEvents(), []);
    assert.doesNotThrow(() => next.assertAcceptingInput());
    assert.equal(existsSync(join(journalRoot, ".scout.lock")), false);
    await next.stop();
    assert.equal(prepare.mock.callCount(), 0);
    assert.deepEqual(benchmarks.read(), links);
    assert.deepEqual(readJournalEvents(previousPath), events);
    assert.equal(existsSync(join(scope.runRoot, "workflows", "workflow-002")), false);
  } finally {
    await next.stop(); scope.clearWorkflow(next); scope.setWorkflow(workflow);
  }
});

test("Explicit Workflow start prepares installed Domains without copying previous runtime or execution facts", async (t) => {
  const { workflow, eventBus, registerPreparation } = await fixture(t);
  await eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "resume", attachedAt: new Date().toISOString(), processId: process.pid,
  }, { id: "current-runtime-attachment" });
  let preparations = 0;
  registerPreparation(() => {
    preparations += 1;
    return { commit() {}, abort() {}, releasePrevious() {} };
  });
  const previousPath = workflow.journalPath;
  const previousEvents = readJournalEvents(previousPath);
  await workflow.advance("error");


  assert.equal(preparations, 0);
  await workflow.startWorkflow();

  const attachments = workflow.readEvents().filter((event) => RunEvents.runtime.attached.is(event));
  assert.equal(attachments.length, 0);
  assert.equal(preparations, 1);
  const retained = readJournalEvents(previousPath);
  assert.deepEqual(retained.slice(0, -2), previousEvents);
  assert.equal(WorkflowEvents.workflow.advanced.is(retained.at(-2)!), true);
  assert.equal(WorkflowEvents.workflow.completed.is(retained.at(-1)!), true);
  assert.equal(retained.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
});

test("An error terminal finishes its Workflow without replacing lastSuccess", async (t) => {
  const { workflow, benchmarks, submit } = await fixture(t);
  for (let index = 0; index < 4; index += 1) await workflow.advance("completed");
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(benchmarks.read()?.lastSuccess, "workflow-001");

  assert.equal(workflow.snapshot(), undefined);
  assert.equal(benchmarks.read()?.lastSuccess, "workflow-001");
  await submit("next");
  assert.equal(workflow.snapshot(), undefined);
  await workflow.startWorkflow();
  const advanced = await workflow.advance("error");
  assert.equal(advanced.status, "advanced");
  assert.equal(advanced.result.cycleCompleted, true);
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(benchmarks.read()?.lastSuccess, "workflow-001");
  await assert.rejects(async () => await workflow.advance("error"), /Workflow is unavailable/);

  assert.equal(workflow.snapshot(), undefined);
  assert.equal(benchmarks.read()?.currentWorkflow, "workflow-002");
  assert.equal(benchmarks.read()?.lastSuccess, "workflow-001");
});

test("Exit releases independent records despite cleanup errors and blocks reuse of unsafe resources", async (t) => {
  const { workflow, scope, base, eventBus, benchmarks } = await fixture(t);
  const journalRoot = workflow.journalRoot;
  const journalPath = workflow.journalPath;
  const cleanup: string[] = [];
  const errors: unknown[] = [];
  eventBus.subscribe(SystemEvents.interaction.disclosureRequested, ({ payload }) => { errors.push(payload); });
  t.mock.method(base, "finishWorkflow", () => {
    cleanup.push("base.finish");
    throw new Error("Base business cleanup failed");
  });
  scope.domainRegistry.register({
    description: { id: ScoutDomainId.Rbt, name: "Cleanup test Domain" },
    backend: new class extends DomainAgentBackend {
      override async handleDynamicToolCall() { return undefined; }
    }(),
    finishWorkflow() { cleanup.push("rbt.finish"); },
  });
  const unsubscribe = eventBus.subscribe(WorkflowEvents.workflow.releasing, () => {
    cleanup.push("record.release");
    throw new Error("Recording peer cleanup failed");
  }, { priority: EventSubscriptionPriorities.Critical });
  t.after(unsubscribe);
  const advanced = await workflow.advance("error");
  assert.equal(advanced.status, "advanced");
  assert.equal(advanced.result.cycleCompleted, true);
  await assert.rejects(workflow.startWorkflow(), /resource release failed/);
  assert.deepEqual(cleanup, ["base.finish", "rbt.finish", "record.release"]);
  assert.equal(existsSync(join(journalRoot, ".scout.lock")), false);
  assert.equal(existsSync(join(journalRoot, ".base.lock")), false);
  assert.equal(existsSync(join(scope.runRoot, ".workflow.lock")), true);
  assert.equal(benchmarks.read()?.currentWorkflow, "workflow-001");
  const events = readJournalEvents(journalPath);
  assert.equal(events.at(-1)?.key.routeKey, WorkflowEvents.workflow.completed.routeKey);
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(workflow.graph.completedOutcome, "error");
  assert.equal(workflow.lastSeq, 0);
  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors), /Base business cleanup failed/);
  assert.match(JSON.stringify(errors), /Recording peer cleanup failed/);
  assert.equal(events.some((event) => [
    WorkflowEvents.workflow.preparing.routeKey, WorkflowEvents.workflow.committing.routeKey,
    WorkflowEvents.workflow.aborting.routeKey, WorkflowEvents.workflow.releasingPrevious.routeKey,
    WorkflowEvents.workflow.releasing.routeKey,
  ].includes(event.key.routeKey)), false, "runtime boundaries must never be replayable evidence");
  assert.throws(() => workflow.assertAcceptingInput(), /resource release failed/);
  await assert.rejects(workflow.startWorkflow(), /resource release failed/);
  assert.equal(existsSync(join(scope.runRoot, "workflows", "workflow-002")), false);
});

test("Concurrent explicit starts cannot create two Workflows", async (t) => {
  const { workflow, base, benchmarks, submit, registerPreparation } = await fixture(t);
  await workflow.advance("error");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const prepared = new Promise<void>((resolve) => { entered = resolve; });
  let preparations = 0;
  let commits = 0;
  registerPreparation(async () => {
    preparations += 1;
    entered();
    await gate;
    return { commit() { commits += 1; }, abort() {}, releasePrevious() {} };
  });
  await submit("must-not-start-workflow");
  assert.equal(preparations, 0);

  const first = workflow.startWorkflow();
  const second = assert.rejects(workflow.startWorkflow(), /Workflow is transitioning/);
  await prepared;
  await assert.rejects(submit("during-switch"), /Workflow is transitioning/);
  await assert.rejects(async () => await workflow.advance("completed"), /Workflow is transitioning/);
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(benchmarks.read()?.currentWorkflow, "workflow-001");
  release();
  await Promise.all([first, second]);
  assert.equal(preparations, 1);
  assert.equal(commits, 1);
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
  assert.equal(benchmarks.read()?.lastWorkflow, "workflow-002");
  await Promise.all([submit("first"), submit("second")]);
  const events = readJournalEvents(workflow.journalPath);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]);
  assert.deepEqual(events.flatMap((event) => SystemEvents.interaction.userMessageSubmitted.is(event) ? [event.payload.text] : []), ["first", "second"]);
  assert.deepEqual(base.recordObject.readAll(), []);
  assert.equal(existsSync(join(workflow.journalRoot, ".base.lock")), true);
});

test("A later Domain prepare failure preserves completed evidence and leaves an idle runtime for retry", async (t) => {
  const { runRoot, workflow, base, benchmarks, submit, registerPreparation } = await fixture(t);
  const oldPath = workflow.journalPath;
  const oldLinks = benchmarks.read();
  const original = base.recordObject.write({
    id: "base-original", key: RunEvents.runtime.attached,
    payload: { mode: "start" }, occurredAt: new Date().toISOString(),
  });
  await workflow.advance("error");
  let fail = true;
  registerPreparation(() => {
    if (fail) throw new Error("RBT prepare failed");
    return { commit() {}, abort() {}, releasePrevious() {} };
  });

  const oldContents = readFileSync(oldPath, "utf8");
  await assert.rejects(workflow.startWorkflow(), /RBT prepare failed/);
  assert.equal(workflow.snapshot(), undefined);
  assert.deepEqual(base.recordObject.readAll(), []);
  assert.equal(readFileSync(oldPath, "utf8"), oldContents);
  assert.deepEqual(benchmarks.read(), oldLinks);
  assert.equal(existsSync(join(runRoot, "workflows", "workflow-002")), false);
  assert.deepEqual(readJournalEvents(join(runRoot, "workflows", "workflow-001", "journal", "base.journal")), [original]);
  fail = false;
  await workflow.startWorkflow();
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
  assert.deepEqual(base.recordObject.readAll(), []);
});

test("A boundary permalink failure aborts all preparations without switching active journals", async (t) => {
  const { runRoot, workflow, base, benchmarks, submit } = await fixture(t);
  const oldPath = workflow.journalPath;
  const links = benchmarks.read();
  await workflow.advance("error");

  const oldContents = readFileSync(oldPath, "utf8");
  const mock = t.mock.method(ScoutBenchmarks.prototype, "recordStarted", () => { throw new Error("start permalink failed"); });
  await assert.rejects(workflow.startWorkflow(), /start permalink failed/);
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(readFileSync(oldPath, "utf8"), oldContents);
  assert.deepEqual(base.recordObject.readAll(), []);
  assert.deepEqual(benchmarks.read(), links);
  assert.equal(existsSync(join(runRoot, "workflows", "workflow-002")), false);
  mock.mock.restore();
  await workflow.startWorkflow();
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
});

test("An abort failure retains the prepared directory and blocks a destructive retry", async (t) => {
  const { runRoot, workflow, base, submit, registerPreparation } = await fixture(t);
  const completedRoot = workflow.journalRoot;
  await workflow.advance("error");

  const nextRoot = join(runRoot, "workflows", "workflow-002");
  const cleanupOrder: string[] = [];
  const abortBase = base.recordObject.abortPreparedWorkflow.bind(base.recordObject);
  t.mock.method(base.recordObject, "abortPreparedWorkflow", () => {
    cleanupOrder.push("base.abort");
    abortBase();
  });
  const discardScout = workflow.scoutRecordObject.abortPreparedWorkflow.bind(workflow.scoutRecordObject);
  t.mock.method(workflow.scoutRecordObject, "abortPreparedWorkflow", () => {
    cleanupOrder.push("scout.discard");
    discardScout();
  });
  const discardDirectory = t.mock.method(ScoutBenchmarks.prototype, "discard");
  registerPreparation(() => {
    writeFileSync(join(nextRoot, "held-resource"), "held");
    return {
      commit() {},
      abort() {
        cleanupOrder.push("rbt.abort");
        throw new Error("resource still held");
      },
      releasePrevious() {},
    };
  });
  t.mock.method(ScoutBenchmarks.prototype, "recordStarted", () => { throw new Error("start failed"); });
  await assert.rejects(workflow.startWorkflow(), /prepared Workflow resources/);
  assert.deepEqual(cleanupOrder, ["scout.discard", "base.abort", "rbt.abort"]);
  assert.equal(discardDirectory.mock.callCount(), 0);
  assert.equal(existsSync(join(nextRoot, "journal", ".base.lock")), false);
  assert.equal(existsSync(join(nextRoot, "journal", ".scout.lock")), false);
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(existsSync(join(nextRoot, "held-resource")), true);
  await assert.rejects(workflow.startWorkflow(), /prepared Workflow resources/);
  assert.deepEqual(cleanupOrder, ["scout.discard", "base.abort", "rbt.abort"]);
  assert.equal(discardDirectory.mock.callCount(), 0);
  assert.equal(existsSync(join(nextRoot, "held-resource")), true);
});

test("A postcommit release failure never deletes the new Workflow or pretends to roll it back", async (t) => {
  const { runRoot, workflow, base, benchmarks, submit, registerPreparation } = await fixture(t);
  const completedRoot = workflow.journalRoot;
  await workflow.advance("error");

  const previousRoot = completedRoot;
  const cleanupOrder: string[] = [];
  const releaseBase = base.recordObject.releasePrevious.bind(base.recordObject);
  t.mock.method(base.recordObject, "releasePrevious", () => {
    cleanupOrder.push("base.releasePrevious");
    releaseBase();
  });
  const releaseScout = workflow.scoutRecordObject.releasePrevious.bind(workflow.scoutRecordObject);
  t.mock.method(workflow.scoutRecordObject, "releasePrevious", () => {
    cleanupOrder.push("scout.releasePrevious");
    releaseScout();
  });
  const discardScout = t.mock.method(workflow.scoutRecordObject, "abortPreparedWorkflow");
  const discardDirectory = t.mock.method(ScoutBenchmarks.prototype, "discard");
  registerPreparation(() => ({
    commit() {}, abort() { assert.fail("a committed preparation cannot be aborted"); },
    releasePrevious() {
      cleanupOrder.push("rbt.releasePrevious");
      throw new Error("old resource release failed");
    },
  }));
  await assert.rejects(workflow.startWorkflow(), /committed but its entry transaction failed/);
  assert.deepEqual(cleanupOrder, ["scout.releasePrevious", "base.releasePrevious", "rbt.releasePrevious"]);
  assert.equal(discardScout.mock.callCount(), 0);
  assert.equal(discardDirectory.mock.callCount(), 0);
  assert.equal(existsSync(join(previousRoot, ".base.lock")), false);
  assert.equal(existsSync(join(previousRoot, ".scout.lock")), false);
  assert.equal(existsSync(join(workflow.journalRoot, ".base.lock")), true);
  assert.equal(existsSync(join(workflow.journalRoot, ".scout.lock")), true);
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
  assert.equal(benchmarks.read()?.currentWorkflow, "workflow-002");
  assert.equal(readJournalEvents(workflow.journalPath).length, 2);
  assert.equal(existsSync(join(runRoot, "workflows", "workflow-001", "journal", "scout.journal")), true);
  assert.equal(existsSync(join(workflow.journalRoot, "base.journal")), true);
  await assert.rejects(async () => await workflow.advance("completed"), /committed but its entry transaction failed/);
  await assert.rejects(submit("retry"), /committed but its entry transaction failed/);
});

test("Quiescing rejects new input and drains an accepted Workflow transition before shutdown", async (t) => {
  const { workflow, submit, registerPreparation } = await fixture(t);
  const completedRoot = workflow.journalRoot;
  await workflow.advance("error");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const prepared = new Promise<void>((resolve) => { entered = resolve; });
  let committed = false;
  registerPreparation(async () => {
    entered();
    await gate;
    return { commit() { committed = true; }, abort() {}, releasePrevious() {} };
  });
  const accepted = workflow.startWorkflow();
  await prepared;
  let drained = false;
  const stop = workflow.quiesce().then(() => { drained = true; });
  await assert.rejects(submit("too-late"), /Workflow is stopping/);
  await assert.rejects(async () => await workflow.advance("completed"), /not accepting Graph changes/);
  assert.equal(drained, false);
  assert.equal(committed, false);
  release();
  await Promise.all([accepted, stop]);
  assert.equal(committed, true);
  assert.equal(drained, true);
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
});

test("Direct Workflow.stop drains accepted input before closing ScoutRecordObject and rejects later admission", async (t) => {
  const { workflow, eventBus, submit } = await fixture(t);
  const path = workflow.journalPath;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  eventBus.subscribe(SystemEvents.interaction.userMessageSubmitted, (event) => {
    if (SystemEvents.interaction.userMessageSubmitted.is(event) && event.payload.text === "accepted") return gate;
  }, {
    priority: EventSubscriptionPriorities.Critical,
  });
  const received: string[] = [];
  eventBus.subscribe(SystemEvents.interaction.userMessageSubmitted, (event) => {
    if (SystemEvents.interaction.userMessageSubmitted.is(event)) received.push(event.payload.text);
  });
  let closed = false;
  const original = workflow.scoutRecordObject.stop.bind(workflow.scoutRecordObject);
  t.mock.method(workflow.scoutRecordObject, "stop", () => {
    assert.deepEqual(received, ["accepted"]);
    original();
    closed = true;
  });
  const accepted = submit("accepted");
  const stopping = workflow.stop();
  await assert.rejects(submit("late"), /Workflow is stopping/);
  assert.equal(closed, false);
  release();
  await Promise.all([accepted, stopping]);
  assert.equal(closed, true);
  assert.deepEqual(readJournalEvents(path).flatMap((event) =>
    SystemEvents.interaction.userMessageSubmitted.is(event) ? [event.payload.text] : []
  ), ["accepted"]);
  assert.throws(() => workflow.assertAcceptingInput(), /Workflow is stopping or not started/);
});

test("User input recording failure is disclosed but neither cancels delivery nor prevents stop", async (t) => {
  const { workflow, eventBus, submit } = await fixture(t);
  const received: string[] = [];
  const failures: string[] = [];
  eventBus.subscribe(SystemEvents.interaction.userMessageSubmitted, (event) => {
    if (SystemEvents.interaction.userMessageSubmitted.is(event)) received.push(event.payload.text);
  });
  eventBus.subscribe(RunEvents.journal.writeFailed, (event) => {
    if (RunEvents.journal.writeFailed.is(event)) failures.push(event.payload.failedEventKey);
  });
  const original = Journal.prototype.append;
  const append = t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
    if (this.path === workflow.journalPath && SystemEvents.interaction.userMessageSubmitted.is(event)) {
      throw new Error("user input disk write failed");
    }
    return original.call(this, event);
  });
  await submit("still-delivered");
  assert.deepEqual(received, ["still-delivered"]);
  assert.deepEqual(failures, [SystemEvents.interaction.userMessageSubmitted.routeKey]);
  assert.equal(append.mock.callCount(), 2);
  assert.equal(workflow.readEvents().some((event) => SystemEvents.interaction.userMessageSubmitted.is(event)), false);
  await workflow.stop();
});

test("Workflow settlement drains admitted input without implicitly creating or replaying another Workflow", async (t) => {
  const { workflow, eventBus, submit, registerPreparation } = await fixture(t);
  const oldPath = workflow.journalPath;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  eventBus.subscribe(SystemEvents.interaction.userMessageSubmitted, () => gate, {
    priority: EventSubscriptionPriorities.Critical,
  });
  let preparations = 0;
  registerPreparation(() => {
    preparations += 1;
    return { commit() {}, abort() {}, releasePrevious() {} };
  });
  const accepted = submit("belongs-to-next-workflow");
  const transition = workflow.advance("error");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(preparations, 0);
  assert.equal(workflow.journalPath, oldPath);
  release();
  await Promise.all([accepted, transition]);
  assert.equal(preparations, 0);
  assert.equal(workflow.snapshot(), undefined);
  const oldEvents = readJournalEvents(oldPath);
  assert.ok(oldEvents.some((event) => SystemEvents.interaction.userMessageSubmitted.is(event)));
  assert.equal(oldEvents.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
  assert.deepEqual(workflow.readEvents(), []);
  await workflow.startWorkflow();
  assert.equal(preparations, 1);
  assert.deepEqual(projectRun(workflow.readEvents(), "coordinator").pendingMessages, []);
  assert.deepEqual(readJournalEvents(oldPath), oldEvents);
});

test("Completed Workflow resume preserves historical benchmarks and does not replay pending historical input", async (t) => {
  const { runRoot, workflow, scope, base, benchmarks, submit } = await fixture(t);
  const previousPath = workflow.journalPath;
  const journalRoot = workflow.journalRoot;
  await submit("pending-across-completion-crash");
  for (let index = 0; index < 3; index += 1) await workflow.advance("completed");
  const success = t.mock.method(ScoutBenchmarks.prototype, "recordSuccess", () => {
    throw new Error("crash after completed fact before success permalink");
  });
  const advanced = await workflow.advance("completed");
  assert.equal(advanced.status, "advanced");
  assert.equal(advanced.result.cycleCompleted, true);
  success.mock.restore();
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(benchmarks.read()?.lastSuccess, undefined);
  const previousEvents = readJournalEvents(previousPath);
  assert.equal(previousEvents.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
  const next = new Workflow(createTestWorkflowAsset(workflow.graph.snapshot()));
  const nextRecovery = {
    graphState: workflow.graph.snapshot(),
    workflowState: projectWorkflowState("workflow-001", previousEvents), journalRoot
  };
  await workflow.stop();
  base.close();
  for (const domain of scope.domainRegistry.list()) scope.domainRegistry.unregister(domain);
  scope.clearWorkflow(workflow);
  scope.setWorkflow(next);
  try {
    await next.start();
    next.restore(nextRecovery);
    assert.equal(benchmarks.read()?.lastSuccess, undefined);
    assert.equal(benchmarks.read()?.currentWorkflow, "workflow-001");
    assert.equal(next.snapshot(), undefined);
    assert.deepEqual(next.readEvents(), []);
    assert.equal(existsSync(join(runRoot, "workflows", "workflow-002")), false);
    assert.deepEqual(readJournalEvents(previousPath), previousEvents);
  } finally {
    await next.stop();
    scope.clearWorkflow(next);
    scope.setWorkflow(workflow);
  }
  assert.equal(existsSync(join(runRoot, ".workflow.lock")), false);
});

test("An initial baseline write failure cannot move published benchmarks and a retry publishes a complete baseline", async (t) => {
  const { workflow, scope, base, benchmarks } = await fixture(t);
  const previousPath = workflow.journalPath;
  const previousContents = readFileSync(previousPath, "utf8");
  const previousLinks = benchmarks.read();
  const manifest = scope.manifestStore.read();
  const next = new Workflow(createTestWorkflowAsset(workflow.graph.snapshot()));
  await workflow.stop();
  base.close();
  for (const domain of scope.domainRegistry.list()) scope.domainRegistry.unregister(domain);
  scope.clearWorkflow(workflow);
  scope.setWorkflow(next);
  const replace = t.mock.method(Journal.prototype, "replaceAll", () => {
    throw new Error("initial baseline could not be persisted");
  });
  try {
    await next.start();
    await assert.rejects(next.startWorkflow(), /initial baseline could not be persisted/);
    assert.deepEqual(benchmarks.read(), previousLinks);
    assert.equal(readFileSync(previousPath, "utf8"), previousContents);
    assert.deepEqual(scope.manifestStore.read(), manifest);
    assert.equal(existsSync(join(scope.runRoot, ".workflow.lock")), true);
    replace.mock.restore();
    await next.startWorkflow();
    assert.equal(benchmarks.read()?.currentWorkflow, "workflow-002");
    const events = next.readEvents();
    assert.deepEqual(events.map((event) => event.key.routeKey), [
      RunEvents.run.created.routeKey,
      WorkflowEvents.workflow.initialized.routeKey,
    ]);
    assert.ok(RunEvents.run.created.is(events[0]!));
    assert.equal(events[0]!.payload.runId, manifest.runId);
    assert.equal(events[0]!.payload.createdAt, manifest.createdAt);
    assert.deepEqual(projectGraphState(events), next.graph.snapshot());
    assert.equal(readFileSync(previousPath, "utf8"), previousContents);
  } finally {
    replace.mock.restore();
    await next.stop();
    scope.clearWorkflow(next);
    scope.setWorkflow(workflow);
  }
});

test("A Workflow stop failure keeps the root lease until its owner successfully retries cleanup", async (t) => {
  const { runRoot, workflow } = await fixture(t);
  const rootLock = join(runRoot, ".workflow.lock");
  const journalLock = join(workflow.journalRoot, ".scout.lock");
  const rootOwner = readFileSync(rootLock, "utf8");
  const journalOwner = readFileSync(journalLock, "utf8");
  const close = t.mock.method(workflow.scoutRecordObject, "stop", () => { throw new Error("journal still held"); });
  try {
    await assert.rejects(workflow.stop(), /journal still held/);
    assert.equal(existsSync(rootLock), true);
    assert.equal(existsSync(journalLock), true);
    assert.throws(() => new ScoutBenchmarks(new Benchmarks(runRoot)).benchmarks.acquire(), /already attached/);
    await assert.rejects(workflow.start(), /still owns resources from a failed cleanup; stop it before restarting/);
    assert.equal(readFileSync(rootLock, "utf8"), rootOwner);
    assert.equal(readFileSync(journalLock, "utf8"), journalOwner);
    assert.equal(close.mock.callCount(), 1);
  } finally {
    close.mock.restore();
    await workflow.stop();
  }
  assert.equal(existsSync(rootLock), false);
  assert.equal(existsSync(journalLock), false);
  const nextOwner = new ScoutBenchmarks(new Benchmarks(runRoot));
  nextOwner.benchmarks.acquire();
  nextOwner.benchmarks.release();
});

test("StartWorkflowStage retains the installed service after startup cleanup fails until stop succeeds", async (t) => {
  const { runRoot, workflow, scope, base } = await fixture(t);
  const next = new Workflow(createTestWorkflowAsset(workflow.graph.snapshot()));
  const stage = new StartWorkflowStage(next);
  const rootLock = join(runRoot, ".workflow.lock");
  await workflow.stop();
  base.close();
  for (const domain of scope.domainRegistry.list()) scope.domainRegistry.unregister(domain);
  scope.clearWorkflow(workflow);
  const baselineFailure = new Error("startup baseline failed");
  const closeFailure = new Error("startup journal cleanup failed");
  const replace = t.mock.method(next.scoutRecordObject, "start", () => { throw baselineFailure; });
  const close = t.mock.method(next.scoutRecordObject, "stop", () => { throw closeFailure; });
  try {
    await assert.rejects(stage.start(), (error) => error instanceof AggregateError
      && error.errors.includes(baselineFailure) && error.errors.includes(closeFailure));
    assert.equal(scope.workflow, next);
    assert.equal(existsSync(rootLock), true);
    await assert.rejects(stage.start(), /cleanup is pending/);
    assert.throws(() => new ScoutBenchmarks(new Benchmarks(runRoot)).benchmarks.acquire(), /already attached/);
    replace.mock.restore();
    close.mock.restore();
    await stage.stop();
    assert.throws(() => scope.workflow, /Workflow Service is not available/);
    assert.equal(existsSync(rootLock), false);
    await stage.stop();
  } finally {
    replace.mock.restore();
    close.mock.restore();
    await stage.stop();
    scope.setWorkflow(workflow);
  }
});

test("StartWorkflowStage retains a service whose stop failed and clears it only after successful retry", async (t) => {
  const { runRoot, workflow, scope, base } = await fixture(t);
  const stage = new StartWorkflowStage(workflow);
  const rootLock = join(runRoot, ".workflow.lock");
  const originalOwner = readFileSync(rootLock, "utf8");
  scope.clearWorkflow(workflow);
  await stage.start();
  base.close();
  for (const domain of scope.domainRegistry.list()) scope.domainRegistry.unregister(domain);
  const close = t.mock.method(workflow.scoutRecordObject, "stop", () => { throw new Error("stage journal cleanup failed"); });
  try {
    await assert.rejects(stage.stop(), /stage journal cleanup failed/);
    await assert.rejects(stage.start(), /cleanup is pending/);
    assert.equal(scope.workflow, workflow);
    assert.equal(readFileSync(rootLock, "utf8"), originalOwner);
    assert.throws(() => new ScoutBenchmarks(new Benchmarks(runRoot)).benchmarks.acquire(), /already attached/);
    close.mock.restore();
    await stage.stop();
    assert.throws(() => scope.workflow, /Workflow Service is not available/);
    assert.equal(existsSync(rootLock), false);
    await stage.stop();
  } finally {
    close.mock.restore();
    await stage.stop();
    scope.setWorkflow(workflow);
  }
});

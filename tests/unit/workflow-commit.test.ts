import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { agent } from "../../src/agent/context/agent-attachments.js";
import { AgentEvents } from "../../src/agent/events/index.js";
import { EventSubscriptionPriorities, InMemoryEventBus, type EventType, type ScoutEvent } from "../../src/core/events/index.js";
import { Journal, readJournalEvents } from "../../src/core/journal/index.js";
import { Workflow, WorkflowBenchmarks, WorkflowEvents, projectWorkflowState } from "../../src/core/workflow/index.js";
import { BaseDomain, DomainAgentBackend, ScoutDomainId, type ScoutDomainWorkflowChange } from "../../src/domain/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { WorkflowStage } from "../../src/run/lifecycle/stages/workflow-stage.js";
import { projectGraphState, projectRun } from "../../src/run/resume/projection/index.js";
import { SystemEvents } from "../../src/system/events/index.js";
import { createTestRunPersistence, installTestRunScope } from "../helpers/run-persistence.js";

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
  const benchmarks = new WorkflowBenchmarks(scope.runRoot);
  const submit = (text: string) => eventBus.publishAndWait(SystemEvents.interaction.userMessageSubmitted, {
    messageId: text, text, attachment: agent.turn.message(text), submittedAt: new Date().toISOString(),
  });
  const registerPreparation = (prepareWorkflow: () => Promise<ScoutDomainWorkflowChange> | ScoutDomainWorkflowChange) => {
    scope.domainRegistry.register({
      description: { id: ScoutDomainId.Rbt, name: "Transition test Domain" },
      backend: new class extends DomainAgentBackend {
        override async handleDynamicToolCall() { return undefined; }
      }(),
      prepareWorkflow,
    });
  };
  return { runRoot: scope.runRoot, eventBus, scope, workflow, base, benchmarks, submit, registerPreparation };
}

test("Workflow Graph preview is pure and a journal failure cannot advance live state", async (t) => {
  const { workflow, eventBus } = await fixture(t);
  const graph = workflow.scheduler.snapshot();
  const workflowState = workflow.snapshot()!;
  const seq = workflow.lastSeq;
  assert.equal(workflow.graph.previewAdvance("completed").state.currentPhase, "research-reviewer");
  assert.deepEqual(workflow.scheduler.snapshot(), graph);
  let broadcasts = 0;
  eventBus.subscribe(WorkflowEvents.workflow.advanced, () => { broadcasts += 1; });
  const original = Journal.prototype.append;
  const append = t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
    if (this.path === workflow.journalPath) throw new Error("journal unavailable");
    return original.call(this, event);
  });
  assert.throws(() => workflow.scheduler.advance("completed"), /journal unavailable/);
  assert.equal(append.mock.callCount(), 2);
  assert.deepEqual(workflow.scheduler.snapshot(), graph);
  assert.deepEqual(workflow.snapshot(), workflowState);
  assert.equal(workflow.lastSeq, seq);
  assert.equal(broadcasts, 0);
  append.mock.restore();
  workflow.scheduler.advance("completed");
  await Promise.resolve();
  assert.equal(workflow.lastSeq, seq + 1);
  assert.equal(broadcasts, 1);
  assert.deepEqual(projectGraphState(workflow.readEvents()), workflow.scheduler.snapshot());
});

test("Workflow records completion during settlement and retains it when the success permalink fails", async (t) => {
  const { workflow, benchmarks, eventBus } = await fixture(t);
  workflow.scheduler.advance("completed");
  workflow.scheduler.advance("completed");
  workflow.scheduler.advance("completed");
  const priorLinks = benchmarks.read();
  let broadcasts = 0;
  eventBus.subscribe(WorkflowEvents.workflow.advanced, () => { broadcasts += 1; });
  t.mock.method(WorkflowBenchmarks.prototype, "recordSuccess", () => { throw new Error("benchmark unavailable"); });
  const terminalPhase = workflow.scheduler.snapshot().currentPhase;
  workflow.scheduler.advance("completed");
  assert.equal(workflow.snapshot()?.status, "settling");
  assert.equal(workflow.scheduler.snapshot().currentPhase, terminalPhase);
  assert.equal(workflow.readEvents().some((event) => WorkflowEvents.workflow.completed.is(event)), false);
  assert.deepEqual(benchmarks.read(), priorLinks);
  await assert.rejects(workflow.settleWorkflow(), /benchmark unavailable/);
  await Promise.resolve();
  assert.equal(workflow.snapshot()?.status, "completed");
  assert.equal(workflow.readEvents().filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
  assert.deepEqual(projectWorkflowState("workflow-001", workflow.readEvents()), workflow.snapshot());
  assert.deepEqual(projectGraphState(workflow.readEvents()), workflow.scheduler.snapshot());
  assert.deepEqual(benchmarks.read(), priorLinks);
  assert.equal(broadcasts, 1);
  const seq = workflow.lastSeq;
  assert.throws(() => workflow.scheduler.advance("completed"), /completed Workflow/);
  assert.equal(workflow.lastSeq, seq);
});

test("Workflow initialization propagates persistence failure without broadcasting a fact", async (t) => {
  const { workflow, eventBus } = await fixture(t);
  const workflowState = workflow.snapshot();
  const seq = workflow.lastSeq;
  let broadcasts = 0;
  eventBus.subscribe(WorkflowEvents.workflow.initialized, () => { broadcasts += 1; });
  t.mock.method(workflow.scoutJournal, "write", () => { throw new Error("initialization write failed"); });
  assert.throws(() => workflow.initialize(), /initialization write failed/);
  assert.deepEqual(workflow.snapshot(), workflowState);
  assert.equal(workflow.lastSeq, seq);
  assert.equal(broadcasts, 0);
});

test("Workflow startup failure stops Scheduler even when journal cleanup also fails", async (t) => {
  const { workflow, scope, runRoot, base } = await fixture(t);
  const created = workflow.readEvents().find((event) => RunEvents.run.created.is(event));
  assert.ok(created);
  const next = new Workflow({ graphState: workflow.graph.snapshot(), resume: { workflowState: workflow.snapshot()!, journalRoot: workflow.journalRoot } });
  await workflow.stop();
  base.close();
  scope.clearWorkflow(workflow);
  scope.setWorkflow(next);
  const writeFailure = new Error("initialization write failed");
  const closeFailure = new Error("cleanup failed");
  const write = t.mock.method(next.scoutJournal, "open", () => { throw writeFailure; });
  const stop = next.scoutJournal.stop.bind(next.scoutJournal);
  const close = t.mock.method(next.scoutJournal, "stop", () => { stop(); throw closeFailure; });
  try {
    await assert.rejects(next.start(), (error) => error instanceof AggregateError
      && error.errors.includes(writeFailure) && error.errors.includes(closeFailure));
    assert.throws(() => next.scheduler.advance("completed"), /Scheduler is not started/);
    assert.throws(() => next.advanceGraph("completed"), /not accepting Graph changes/);
    assert.throws(() => new WorkflowBenchmarks(runRoot).acquire(), /already attached/);
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
  workflow.scheduler.advance("error");
  const previousPath = workflow.journalPath;
  const journalRoot = workflow.journalRoot;
  await workflow.settleWorkflow();
  const events = readJournalEvents(previousPath);
  const links = benchmarks.read();
  const next = new Workflow({ graphState: projectGraphState(events), resume: {
    workflowState: projectWorkflowState("workflow-001", events), journalRoot,
  } });
  await workflow.stop();
  base.close();
  for (const domain of scope.domainRegistry.list()) scope.domainRegistry.unregister(domain);
  scope.clearWorkflow(workflow);
  scope.setWorkflow(next);
  const prepare = t.mock.method(next.scoutJournal, "prepare");
  try {
    await next.start();
    assert.equal(next.snapshot(), undefined);
    assert.deepEqual(next.readEvents(), []);
    assert.doesNotThrow(() => next.assertAcceptingInput());
    assert.equal(existsSync(join(journalRoot, ".scout.lock")), false);
    await Promise.all([next.settleWorkflow(), next.stop()]);
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
  workflow.scheduler.advance("error");
  const previousPath = workflow.journalPath;
  const previousEvents = readJournalEvents(previousPath);

  await workflow.settleWorkflow();
  assert.equal(preparations, 0);
  await workflow.startWorkflow();

  const attachments = workflow.readEvents().filter((event) => RunEvents.runtime.attached.is(event));
  assert.equal(attachments.length, 0);
  assert.equal(preparations, 1);
  const retained = readJournalEvents(previousPath);
  assert.deepEqual(retained.slice(0, -1), previousEvents);
  assert.equal(WorkflowEvents.workflow.completed.is(retained.at(-1)!), true);
  assert.equal(retained.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
});

test("An error terminal finishes its Workflow without replacing lastSuccess", async (t) => {
  const { workflow, benchmarks, submit } = await fixture(t);
  for (let index = 0; index < 4; index += 1) workflow.scheduler.advance("completed");
  assert.equal(workflow.snapshot()?.status, "settling");
  assert.equal(benchmarks.read()?.lastSuccess, undefined);
  await workflow.settleWorkflow();
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(benchmarks.read()?.lastSuccess, "workflow-001");
  await submit("next");
  assert.equal(workflow.snapshot(), undefined);
  await workflow.startWorkflow();
  assert.equal(workflow.scheduler.advance("error").cycleCompleted, true);
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
  assert.equal(workflow.snapshot()?.status, "settling");
  assert.equal(benchmarks.read()?.lastSuccess, "workflow-001");
  assert.throws(() => workflow.scheduler.advance("error"), /completed Workflow/);
  await workflow.settleWorkflow();
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(benchmarks.read()?.currentWorkflow, "workflow-002");
  assert.equal(benchmarks.read()?.lastSuccess, "workflow-001");
});

test("Concurrent explicit starts cannot create two Workflows", async (t) => {
  const { workflow, base, benchmarks, submit, registerPreparation } = await fixture(t);
  workflow.scheduler.advance("error");
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
  await assert.rejects(submit("must-not-start-workflow"), /not ready to accept input/);
  assert.equal(preparations, 0);
  await workflow.settleWorkflow();
  const first = workflow.startWorkflow();
  const second = assert.rejects(workflow.startWorkflow(), /not ready to accept input/);
  await prepared;
  await assert.rejects(submit("during-switch"), /not ready to accept input/);
  assert.throws(() => workflow.scheduler.advance("completed"), /Workflow is transitioning/);
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
  assert.deepEqual(base.journal.readAll(), []);
  assert.equal(existsSync(join(workflow.journalRoot, ".base.lock")), true);
});

test("A later Domain prepare failure preserves completed evidence and leaves an idle runtime for retry", async (t) => {
  const { runRoot, workflow, base, benchmarks, submit, registerPreparation } = await fixture(t);
  workflow.scheduler.advance("error");
  const oldPath = workflow.journalPath;
  const oldLinks = benchmarks.read();
  const original = base.journal.append({
    id: "base-original", key: RunEvents.runtime.attached,
    payload: { mode: "start" }, occurredAt: new Date().toISOString(),
  });
  let fail = true;
  registerPreparation(() => {
    if (fail) throw new Error("RBT prepare failed");
    return { commit() {}, abort() {}, releasePrevious() {} };
  });
  await workflow.settleWorkflow();
  const oldContents = readFileSync(oldPath, "utf8");
  await assert.rejects(workflow.startWorkflow(), /RBT prepare failed/);
  assert.equal(workflow.snapshot(), undefined);
  assert.deepEqual(base.journal.readAll(), []);
  assert.equal(readFileSync(oldPath, "utf8"), oldContents);
  assert.deepEqual(benchmarks.read(), oldLinks);
  assert.equal(existsSync(join(runRoot, "workflows", "workflow-002")), false);
  assert.deepEqual(readJournalEvents(join(runRoot, "workflows", "workflow-001", "journal", "base.journal")), [original]);
  fail = false;
  await workflow.startWorkflow();
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
  assert.deepEqual(base.journal.readAll(), []);
});

test("A boundary permalink failure aborts all preparations without switching active journals", async (t) => {
  const { runRoot, workflow, base, benchmarks, submit } = await fixture(t);
  workflow.scheduler.advance("error");
  const oldPath = workflow.journalPath;
  const links = benchmarks.read();
  await workflow.settleWorkflow();
  const oldContents = readFileSync(oldPath, "utf8");
  const mock = t.mock.method(WorkflowBenchmarks.prototype, "recordStarted", () => { throw new Error("start permalink failed"); });
  await assert.rejects(workflow.startWorkflow(), /start permalink failed/);
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(readFileSync(oldPath, "utf8"), oldContents);
  assert.deepEqual(base.journal.readAll(), []);
  assert.deepEqual(benchmarks.read(), links);
  assert.equal(existsSync(join(runRoot, "workflows", "workflow-002")), false);
  mock.mock.restore();
  await workflow.startWorkflow();
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
});

test("An abort failure retains the prepared directory and blocks a destructive retry", async (t) => {
  const { runRoot, workflow, base, submit, registerPreparation } = await fixture(t);
  workflow.scheduler.advance("error");
  const completedRoot = workflow.journalRoot;
  await workflow.settleWorkflow();
  const nextRoot = join(runRoot, "workflows", "workflow-002");
  const cleanupOrder: string[] = [];
  const prepareBase = base.prepareWorkflow.bind(base);
  t.mock.method(base, "prepareWorkflow", (...args: Parameters<typeof prepareBase>) => {
    const change = prepareBase(...args);
    return {
      ...change,
      abort() {
        cleanupOrder.push("base.abort");
        change.abort();
      },
    };
  });
  const discardScout = workflow.scoutJournal.discard.bind(workflow.scoutJournal);
  t.mock.method(workflow.scoutJournal, "discard", (...args: Parameters<typeof discardScout>) => {
    cleanupOrder.push("scout.discard");
    discardScout(...args);
  });
  const discardDirectory = t.mock.method(WorkflowBenchmarks.prototype, "discard");
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
  t.mock.method(WorkflowBenchmarks.prototype, "recordStarted", () => { throw new Error("start failed"); });
  await assert.rejects(workflow.startWorkflow(), /prepared Workflow resources/);
  assert.deepEqual(cleanupOrder, ["rbt.abort", "base.abort", "scout.discard"]);
  assert.equal(discardDirectory.mock.callCount(), 0);
  assert.equal(existsSync(join(nextRoot, "journal", ".base.lock")), false);
  assert.equal(existsSync(join(nextRoot, "journal", ".scout.lock")), false);
  assert.equal(workflow.snapshot(), undefined);
  assert.equal(existsSync(join(nextRoot, "held-resource")), true);
  await assert.rejects(workflow.startWorkflow(), /prepared Workflow resources/);
  assert.deepEqual(cleanupOrder, ["rbt.abort", "base.abort", "scout.discard"]);
  assert.equal(discardDirectory.mock.callCount(), 0);
  assert.equal(existsSync(join(nextRoot, "held-resource")), true);
});

test("A postcommit release failure never deletes the new Workflow or pretends to roll it back", async (t) => {
  const { runRoot, workflow, base, benchmarks, submit, registerPreparation } = await fixture(t);
  workflow.scheduler.advance("error");
  const completedRoot = workflow.journalRoot;
  await workflow.settleWorkflow();
  const previousRoot = completedRoot;
  const cleanupOrder: string[] = [];
  const prepareBase = base.prepareWorkflow.bind(base);
  t.mock.method(base, "prepareWorkflow", (...args: Parameters<typeof prepareBase>) => {
    const change = prepareBase(...args);
    return {
      ...change,
      releasePrevious() {
        cleanupOrder.push("base.releasePrevious");
        change.releasePrevious();
      },
    };
  });
  const releaseScout = workflow.scoutJournal.releasePrevious.bind(workflow.scoutJournal);
  t.mock.method(workflow.scoutJournal, "releasePrevious", () => {
    cleanupOrder.push("scout.releasePrevious");
    releaseScout();
  });
  const discardScout = t.mock.method(workflow.scoutJournal, "discard");
  const discardDirectory = t.mock.method(WorkflowBenchmarks.prototype, "discard");
  registerPreparation(() => ({
    commit() {}, abort() { assert.fail("a committed preparation cannot be aborted"); },
    releasePrevious() {
      cleanupOrder.push("rbt.releasePrevious");
      throw new Error("old resource release failed");
    },
  }));
  await assert.rejects(workflow.startWorkflow(), /committed but finalization failed/);
  assert.deepEqual(cleanupOrder, ["base.releasePrevious", "rbt.releasePrevious", "scout.releasePrevious"]);
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
  assert.throws(() => workflow.scheduler.advance("completed"), /committed but finalization failed/);
  await assert.rejects(submit("retry"), /committed but finalization failed/);
});

test("Quiescing rejects new input and drains an accepted Workflow transition before shutdown", async (t) => {
  const { workflow, submit, registerPreparation } = await fixture(t);
  workflow.scheduler.advance("error");
  const completedRoot = workflow.journalRoot;
  await workflow.settleWorkflow();
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
  assert.throws(() => workflow.scheduler.advance("completed"), /not accepting Graph changes/);
  assert.equal(drained, false);
  assert.equal(committed, false);
  release();
  await Promise.all([accepted, stop]);
  assert.equal(committed, true);
  assert.equal(drained, true);
  assert.equal(workflow.snapshot()?.workflowId, "workflow-002");
});

test("Direct Workflow.stop drains accepted input before closing ScoutJournal and rejects later admission", async (t) => {
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
  const original = workflow.scoutJournal.stop.bind(workflow.scoutJournal);
  t.mock.method(workflow.scoutJournal, "stop", () => {
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
  workflow.scheduler.advance("error");
  const transition = workflow.settleWorkflow();
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
  await submit("pending-across-completion-crash");
  for (let index = 0; index < 4; index += 1) workflow.scheduler.advance("completed");
  const success = t.mock.method(WorkflowBenchmarks.prototype, "recordSuccess", () => {
    throw new Error("crash after completed fact before success permalink");
  });
  await assert.rejects(workflow.settleWorkflow(), /crash after completed fact/);
  success.mock.restore();
  assert.equal(workflow.snapshot()?.status, "completed");
  assert.equal(benchmarks.read()?.lastSuccess, undefined);
  const previousPath = workflow.journalPath;
  const previousEvents = workflow.readEvents();
  assert.equal(previousEvents.filter((event) => WorkflowEvents.workflow.completed.is(event)).length, 1);
  const next = new Workflow({
    graphState: workflow.graph.snapshot(),
    resume: { workflowState: workflow.snapshot()!, journalRoot: workflow.journalRoot },
  });
  await workflow.stop();
  base.close();
  for (const domain of scope.domainRegistry.list()) scope.domainRegistry.unregister(domain);
  scope.clearWorkflow(workflow);
  scope.setWorkflow(next);
  try {
    await next.start();
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
  const next = new Workflow({ graphState: workflow.graph.snapshot() });
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
  const close = t.mock.method(workflow.scoutJournal, "stop", () => { throw new Error("journal still held"); });
  try {
    await assert.rejects(workflow.stop(), /journal still held/);
    assert.equal(existsSync(rootLock), true);
    assert.equal(existsSync(journalLock), true);
    assert.throws(() => new WorkflowBenchmarks(runRoot).acquire(), /already attached/);
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
  const nextOwner = new WorkflowBenchmarks(runRoot);
  nextOwner.acquire();
  nextOwner.release();
});

test("WorkflowStage retains the installed service after startup cleanup fails until stop succeeds", async (t) => {
  const { runRoot, workflow, scope, base } = await fixture(t);
  const next = new Workflow({ graphState: workflow.graph.snapshot() });
  const stage = new WorkflowStage(next);
  const rootLock = join(runRoot, ".workflow.lock");
  await workflow.stop();
  base.close();
  for (const domain of scope.domainRegistry.list()) scope.domainRegistry.unregister(domain);
  scope.clearWorkflow(workflow);
  const baselineFailure = new Error("startup baseline failed");
  const closeFailure = new Error("startup journal cleanup failed");
  const replace = t.mock.method(next.scheduler, "start", () => { throw baselineFailure; });
  const close = t.mock.method(next.scoutJournal, "stop", () => { throw closeFailure; });
  try {
    await assert.rejects(stage.start(), (error) => error instanceof AggregateError
      && error.errors.includes(baselineFailure) && error.errors.includes(closeFailure));
    assert.equal(scope.workflow, next);
    assert.equal(existsSync(rootLock), true);
    await assert.rejects(stage.start(), /cleanup is pending/);
    assert.throws(() => new WorkflowBenchmarks(runRoot).acquire(), /already attached/);
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

test("WorkflowStage retains a service whose stop failed and clears it only after successful retry", async (t) => {
  const { runRoot, workflow, scope, base } = await fixture(t);
  const stage = new WorkflowStage(workflow);
  const rootLock = join(runRoot, ".workflow.lock");
  const originalOwner = readFileSync(rootLock, "utf8");
  scope.clearWorkflow(workflow);
  await stage.start();
  base.close();
  for (const domain of scope.domainRegistry.list()) scope.domainRegistry.unregister(domain);
  const close = t.mock.method(workflow.scoutJournal, "stop", () => { throw new Error("stage journal cleanup failed"); });
  try {
    await assert.rejects(stage.stop(), /stage journal cleanup failed/);
    await assert.rejects(stage.start(), /cleanup is pending/);
    assert.equal(scope.workflow, workflow);
    assert.equal(readFileSync(rootLock, "utf8"), originalOwner);
    assert.throws(() => new WorkflowBenchmarks(runRoot).acquire(), /already attached/);
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

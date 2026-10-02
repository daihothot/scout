import { WorkflowState } from "../../src/core/workflow/index.js";
import { testWorkflowParticipant } from "../helpers/workflow-participant.js";
import { RbtDomainProjector } from "../../src/domain/domains/rbt/index.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ScoutEvent } from "../../src/core/events/index.js";
import { Journal, readJournalEvents } from "../../src/core/journal/index.js";
import type { LogInput } from "../../src/core/logging/index.js";
import { Workflow } from "../../src/core/workflow/index.js";
import { BaseDomain, ScoutDomainId } from "../../src/domain/index.js";
import {
  RbtDomain,
  RbtEvents,
  RbtRecordObject,
  JarvisBehaviorToolStore,
  type RbtExecutionHistoryReadyEvent,
} from "../../src/domain/domains/rbt/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { installTestRunScope, createTestWorkflowAsset } from "../helpers/run-persistence.js";
import { WorkflowEvents } from "../../src/core/workflow/index.js";

test("RbtRecordObject owns event subscription, history projection, and lock release", async (t) => {
  const scope = await installTestRunScope(t, { runId: "rbt-journal-lifecycle" });
  const journal = new RbtRecordObject();
  t.after(() => journal.close());
  const path = join(scope.workflow.journalRoot, "rbt-events.jsonl");
  const lockPath = join(scope.workflow.journalRoot, ".rbt-events.lock");
  assert.throws(() => journal.read(), /RBT Domain journal is unavailable/);

  journal.start();
  journal.start();
  const event = await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
  await scope.eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "start",
    readyAt: new Date().toISOString(),
  });
  assert.equal(existsSync(lockPath), true);
  assert.equal(journal.read().length, 1);
  assert.deepEqual(readJournalEvents(path), journal.read());
  assert.deepEqual(new RbtDomainProjector().project(journal.read()), {
    domainId: "rbt",
    journalSeq: 1,
    updatedAt: event.occurredAt,
    histories: [{ ...history(1), occurredAt: event.occurredAt }],
    executionPacks: [],
    reviews: [],
  });
  assert.equal(scope.workflow.readEvents().some((entry) => RbtEvents.history.ready.is(entry)), false);

  journal.stop();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(2));
  assert.equal(journal.read().length, 1);
  journal.start();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(3));
  assert.deepEqual(journal.read().map((entry) => entry.seq), [1, 2]);
  assert.deepEqual(new RbtDomainProjector().project(journal.read()).histories.map((entry) => entry.runtimeSequence), [1, 3]);

  journal.close();
  journal.close();
  assert.equal(existsSync(lockPath), false);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(4));
  assert.equal(readJournalEvents(path).length, 2);
  assert.throws(() => journal.read(), /RBT Domain journal is unavailable/);
});

test("RbtRecordObject switches Workflow files without retaining the previous writer target", async (t) => {
  const scope = await installTestRunScope(t, { runId: "rbt-journal-workflow-boundary" });
  const journal = new RbtRecordObject();
  t.after(() => journal.close());
  journal.start();
  const firstRoot = scope.workflow.journalRoot;
  const firstPath = join(firstRoot, "rbt-events.jsonl");
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
  const firstContents = readFileSync(firstPath, "utf8");

  assert.throws(() => journal.prepare(firstRoot), /Journal already exists/);
  assert.equal(journal.read().length, 1);
  assert.equal(existsSync(join(firstRoot, ".rbt-events.lock")), true);

  const nextRoot = join(scope.runRoot, "next-workflow");
  const change = journal.prepare(nextRoot);
  assert.equal(journal.read().length, 1);
  assert.equal(existsSync(join(firstRoot, ".rbt-events.lock")), true);
  assert.equal(existsSync(join(nextRoot, ".rbt-events.lock")), true);
  change.commit();
  journal.start();
  assert.deepEqual(journal.read(), []);
  assert.equal(existsSync(join(firstRoot, ".rbt-events.lock")), true);
  change.releasePrevious();
  assert.equal(existsSync(join(firstRoot, ".rbt-events.lock")), false);
  assert.equal(existsSync(join(nextRoot, ".rbt-events.lock")), true);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(2));
  assert.deepEqual(journal.read().map((entry) => entry.seq), [1]);
  assert.deepEqual(new RbtDomainProjector().project(journal.read()).histories.map((entry) => entry.runtimeSequence), [2]);
  assert.equal(readFileSync(firstPath, "utf8"), firstContents);
  assert.deepEqual(readJournalEvents(join(nextRoot, "rbt-events.jsonl")), journal.read());
  journal.close();
  assert.equal(existsSync(join(nextRoot, ".rbt-events.lock")), false);
});

test("RbtRecordObject resume preserves existing events and creates a missing journal", async (t) => {
  for (const existing of [true, false]) {
    await t.test(existing ? "existing journal" : "missing journal", async (context) => {
      const scoutRoot = mkdtempSync(join(tmpdir(), "rbt-journal-resume-"));
      const runId = `rbt-journal-resume-${existing}`;
      const scope = await installTestRunScope(context, {
        runId,
        scoutRoot,
        runRoot: join(scoutRoot, "run", runId),
      });
      const initialWorkflow = scope.workflow;
      const journalRoot = initialWorkflow.journalRoot;
      const workflowData = initialWorkflow.snapshot()!;
      if (existing) {
        const initialJournal = new RbtRecordObject();
        context.after(() => initialJournal.close());
        initialJournal.start();
        await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
        initialJournal.close();
      }
      const resumedWorkflow = new Workflow(createTestWorkflowAsset(initialWorkflow.graph.snapshot()));
      const resumedWorkflowRecovery = {
        graphData: initialWorkflow.graph.snapshot(),
        workflowData, journalRoot
      };
      await initialWorkflow.stop();
      scope.clearWorkflow(initialWorkflow);
      scope.setWorkflow(resumedWorkflow);
      context.after(() => resumedWorkflow.stop());
      await resumedWorkflow.start();
      await resumedWorkflow.enterState({ state: WorkflowState.Restoring, input: resumedWorkflowRecovery });

      const resumedJournal = new RbtRecordObject();
      context.after(() => resumedJournal.close());
      context.after(() => rmSync(scoutRoot, { recursive: true, force: true }));
      resumedJournal.start();
      assert.equal(resumedJournal.read().length, existing ? 1 : 0);
      await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(2));
      assert.deepEqual(resumedJournal.read().map((entry) => entry.seq), existing ? [1, 2] : [1]);
      assert.deepEqual(
        new RbtDomainProjector().project(resumedJournal.read()).histories.map((entry) => entry.runtimeSequence),
        existing ? [1, 2] : [2],
      );
      resumedJournal.close();
      assert.equal(existsSync(join(journalRoot, ".rbt-events.lock")), false);
    });
  }
});

test("Domain recovery owns its record and projector without shared Run journal traversal", async (t) => {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, { runId: "domain-journal-read-contract", scoutRoot: process.cwd(), domain });
  await domain.start();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
  const base = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  const records = domain.recordObject.read();
  const runtimeObject = new RbtDomainProjector().project(records);
  assert.deepEqual(runtimeObject.histories.map((entry) => entry.runtimeSequence), [1]);
  await domain.restore(scope.workflow.snapshot()!);
  domain.recordObject.close();
  assert.throws(() => domain.recordObject.read(), /RBT Domain journal is unavailable/);
});

test("RbtRecordObject reports append failures and continues recording later events", async (t) => {
  const scope = await installTestRunScope(t, { runId: "rbt-journal-write-failure" });
  const journal = new RbtRecordObject();
  t.after(() => journal.close());
  journal.start();
  const warnings: LogInput[] = [];
  t.mock.method(scope.logger, "warn", (warning: LogInput) => { warnings.push(warning); });
  const originalAppend = Journal.prototype.append;
  let failedAttempts = 0;
  const append = t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
    if (RbtEvents.history.ready.is(event)) {
      failedAttempts += 1;
      throw new Error("RBT journal append failed");
    }
    return originalAppend.call(this, event);
  });
  const failedEvent = await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
  assert.equal(failedAttempts, 2);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.module, "domain.rbt.journal");
  assert.equal(warnings[0]!.event, "rbt_domain_journal_write_failed");
  assert.match(JSON.stringify(warnings[0]!.data), /RBT journal append failed/);
  assert.match(JSON.stringify(warnings[0]!.data), new RegExp(failedEvent.id));
  assert.deepEqual(journal.read(), []);

  append.mock.restore();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(2));
  assert.equal(journal.read().length, 1);
  assert.equal(warnings.length, 1);
});

test("RbtDomain releases journal resources after startup failure and delegates Workflow changes", async (t) => {
  const domain = new RbtDomain();
  const scope = await installTestRunScope(t, {
    runId: "rbt-domain-journal-lifecycle",
    scoutRoot: process.cwd(),
    domain,
  });
  const journalRoot = scope.workflow.journalRoot;
  const path = join(journalRoot, "rbt-events.jsonl");
  const register = t.mock.method(domain.backend, "register", () => {
    throw new Error("RBT registration failed");
  });
  await assert.rejects(domain.start(), /RBT registration failed/);
  assert.equal(existsSync(join(journalRoot, ".rbt-events.lock")), false);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
  assert.deepEqual(readJournalEvents(path), []);

  register.mock.restore();
  await domain.start();
  await domain.run();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(2));
  assert.deepEqual(readJournalEvents(path), domain.recordObject.read());
  const firstContents = readFileSync(path, "utf8");
  const nextRoot = join(scope.runRoot, "next-workflow");
  const clearBehavior = t.mock.method(JarvisBehaviorToolStore.prototype, "clear");
  const boundary = { workflowId: "workflow-002", journalRoot: nextRoot };
  await scope.eventBus.publishAndWait(WorkflowEvents.workflow.preparing, boundary);
  assert.equal(clearBehavior.mock.callCount(), 0);
  assert.deepEqual(new RbtDomainProjector().project(domain.recordObject.read()).histories.map((entry) => entry.runtimeSequence), [2]);
  await scope.eventBus.publishAndWait(WorkflowEvents.workflow.aborting, boundary);
  assert.equal(clearBehavior.mock.callCount(), 0);
  assert.deepEqual(new RbtDomainProjector().project(domain.recordObject.read()).histories.map((entry) => entry.runtimeSequence), [2]);
  const retryBoundary = { ...boundary, journalRoot: join(scope.runRoot, "next-workflow-retry") };
  await scope.eventBus.publishAndWait(WorkflowEvents.workflow.preparing, retryBoundary);
  await scope.eventBus.publishAndWait(WorkflowEvents.workflow.committing, retryBoundary);
  domain.create();
  assert.equal(clearBehavior.mock.callCount(), 1);
  await scope.eventBus.publishAndWait(WorkflowEvents.workflow.releasingPrevious, retryBoundary);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(3));
  assert.equal(readFileSync(path, "utf8"), firstContents);
  assert.deepEqual(readJournalEvents(join(retryBoundary.journalRoot, "rbt-events.jsonl")), domain.recordObject.read());
  await domain.restore({ workflowId: "workflow-002", status: "active", checkpointSeq: 0 });
  assert.deepEqual(new RbtDomainProjector().project(domain.recordObject.read()).histories.map((entry) => entry.runtimeSequence), [3]);
  await domain.stop();
  assert.equal(existsSync(join(retryBoundary.journalRoot, ".rbt-events.lock")), false);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(4));
  assert.equal(readJournalEvents(join(retryBoundary.journalRoot, "rbt-events.jsonl")).length, 1);
});

function history(runtimeSequence: number): RbtExecutionHistoryReadyEvent {
  return {
    bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
    executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
    executorHistoryRef: `run://executor/history-${runtimeSequence}.json`,
    executeFileRef: "run://executor/execute-file.json",
    runtimeSequence,
    campaignId: "campaign",
    scenarioId: "scenario",
    status: "completed",
    agentId: "executor",
    role: "executor",
  };
}

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
import { ValidationDomain } from "../../src/domain/domains/validation/index.js";
import {
  RbtDomain,
  RbtEvents,
  RbtJournal,
  JarvisBehaviorToolStore,
  type RbtExecutionHistoryReadyEvent,
} from "../../src/domain/domains/rbt/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { readDomainJournalProjections } from "../../src/run/resume/projection/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("RbtJournal owns event subscription, history projection, and lock release", async (t) => {
  const scope = installTestRunScope(t, { runId: "rbt-journal-lifecycle" });
  const journal = new RbtJournal();
  t.after(() => journal.close());
  const path = join(scope.workflow.journalRoot, "rbt-events.jsonl");
  const lockPath = join(scope.workflow.journalRoot, ".rbt-events.lock");
  assert.throws(() => journal.readAll(), /RBT Domain journal is unavailable/);

  journal.start();
  journal.start();
  const event = await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
  await scope.eventBus.publishAndWait(RunEvents.runtime.ready, {
    mode: "start",
    readyAt: new Date().toISOString(),
  });
  assert.equal(existsSync(lockPath), true);
  assert.equal(journal.readAll().length, 1);
  assert.deepEqual(readJournalEvents(path), journal.readAll());
  assert.deepEqual(journal.aggregate(journal.readAll()), {
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
  assert.equal(journal.readAll().length, 1);
  journal.start();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(3));
  assert.deepEqual(journal.readAll().map((entry) => entry.seq), [1, 2]);
  assert.deepEqual(journal.aggregate(journal.readAll()).histories.map((entry) => entry.runtimeSequence), [1, 3]);

  journal.close();
  journal.close();
  assert.equal(existsSync(lockPath), false);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(4));
  assert.equal(readJournalEvents(path).length, 2);
  assert.throws(() => journal.readAll(), /RBT Domain journal is unavailable/);
});

test("RbtJournal switches Workflow files without retaining the previous writer target", async (t) => {
  const scope = installTestRunScope(t, { runId: "rbt-journal-workflow-boundary" });
  const journal = new RbtJournal();
  t.after(() => journal.close());
  journal.start();
  const firstRoot = scope.workflow.journalRoot;
  const firstPath = join(firstRoot, "rbt-events.jsonl");
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
  const firstContents = readFileSync(firstPath, "utf8");

  assert.throws(() => journal.prepareWorkflow(firstRoot), /Journal already exists/);
  assert.equal(journal.readAll().length, 1);
  assert.equal(existsSync(join(firstRoot, ".rbt-events.lock")), true);

  const nextRoot = join(scope.runRoot, "next-workflow");
  const change = journal.prepareWorkflow(nextRoot);
  assert.equal(journal.readAll().length, 1);
  assert.equal(existsSync(join(firstRoot, ".rbt-events.lock")), true);
  assert.equal(existsSync(join(nextRoot, ".rbt-events.lock")), true);
  change.commit();
  journal.start();
  assert.deepEqual(journal.readAll(), []);
  assert.equal(existsSync(join(firstRoot, ".rbt-events.lock")), true);
  change.releasePrevious();
  assert.equal(existsSync(join(firstRoot, ".rbt-events.lock")), false);
  assert.equal(existsSync(join(nextRoot, ".rbt-events.lock")), true);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(2));
  assert.deepEqual(journal.readAll().map((entry) => entry.seq), [1]);
  assert.deepEqual(journal.aggregate(journal.readAll()).histories.map((entry) => entry.runtimeSequence), [2]);
  assert.equal(readFileSync(firstPath, "utf8"), firstContents);
  assert.deepEqual(readJournalEvents(join(nextRoot, "rbt-events.jsonl")), journal.readAll());
  journal.close();
  assert.equal(existsSync(join(nextRoot, ".rbt-events.lock")), false);
});

test("RbtJournal resume preserves existing events and creates a missing journal", async (t) => {
  for (const existing of [true, false]) {
    await t.test(existing ? "existing journal" : "missing journal", async (context) => {
      const scoutRoot = mkdtempSync(join(tmpdir(), "rbt-journal-resume-"));
      const runId = `rbt-journal-resume-${existing}`;
      const scope = installTestRunScope(context, {
        runId,
        scoutRoot,
        runRoot: join(scoutRoot, "run", runId),
      });
      const initialWorkflow = scope.workflow;
      const journalRoot = initialWorkflow.journalRoot;
      const workflowState = initialWorkflow.snapshot()!;
      if (existing) {
        const initialJournal = new RbtJournal();
        context.after(() => initialJournal.close());
        initialJournal.start();
        await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
        initialJournal.close();
      }
      const resumedWorkflow = new Workflow({
        graphState: initialWorkflow.graph.snapshot(),
        resume: { workflowState, journalRoot },
      });
      await initialWorkflow.stop();
      scope.clearWorkflow(initialWorkflow);
      scope.setWorkflow(resumedWorkflow);
      context.after(() => resumedWorkflow.stop());
      await resumedWorkflow.start();

      const resumedJournal = new RbtJournal();
      context.after(() => resumedJournal.close());
      context.after(() => rmSync(scoutRoot, { recursive: true, force: true }));
      resumedJournal.start();
      assert.equal(resumedJournal.readAll().length, existing ? 1 : 0);
      await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(2));
      assert.deepEqual(resumedJournal.readAll().map((entry) => entry.seq), existing ? [1, 2] : [1]);
      assert.deepEqual(
        resumedJournal.aggregate(resumedJournal.readAll()).histories.map((entry) => entry.runtimeSequence),
        existing ? [1, 2] : [2],
      );
      resumedJournal.close();
      assert.equal(existsSync(join(journalRoot, ".rbt-events.lock")), false);
    });
  }
});

test("Recovery reads registered Domain journals directly without Domain forwarding methods", async (t) => {
  const domain = new RbtDomain();
  const scope = installTestRunScope(t, {
    runId: "domain-journal-read-contract",
    scoutRoot: process.cwd(),
    domain,
  });
  await domain.start();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(1));
  const base = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  const domains = scope.domainRegistry.list();
  for (const current of domains) {
    for (const name of ["eventJournal", "readJournalEvents", "dynamicToolsForPhase", "handleDynamicToolCall"]) {
      assert.equal(name in current, false, `${current.description.id} still exposes ${name}`);
    }
  }
  const inputs = readDomainJournalProjections(domains);
  assert.deepEqual(inputs.map((input) => input.journal), [base.journal, domain.journal]);
  assert.deepEqual(inputs[0]!.events, base.journal.readAll());
  assert.deepEqual(inputs[1]!.events, domain.journal.readAll());
  assert.deepEqual(domain.journal.aggregate(inputs[1]!.events).histories.map((entry) => entry.runtimeSequence), [1]);

  const projectionOnly = new ValidationDomain();
  scope.domainRegistry.register(projectionOnly);
  assert.equal(projectionOnly.journal.readAll, undefined);
  assert.deepEqual(readDomainJournalProjections(scope.domainRegistry.list()), inputs);
  const withoutJournal = {
    description: projectionOnly.description,
    backend: projectionOnly.backend,
  };
  assert.deepEqual(readDomainJournalProjections([withoutJournal]), []);

  domain.journal.close();
  assert.throws(
    () => readDomainJournalProjections(scope.domainRegistry.list()),
    /RBT Domain journal is unavailable/,
  );
});

test("RbtJournal reports append failures and continues recording later events", async (t) => {
  const scope = installTestRunScope(t, { runId: "rbt-journal-write-failure" });
  const journal = new RbtJournal();
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
  assert.deepEqual(journal.readAll(), []);

  append.mock.restore();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(2));
  assert.equal(journal.readAll().length, 1);
  assert.equal(warnings.length, 1);
});

test("RbtDomain releases journal resources after startup failure and delegates Workflow changes", async (t) => {
  const domain = new RbtDomain();
  const scope = installTestRunScope(t, {
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
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(2));
  assert.deepEqual(readJournalEvents(path), domain.journal.readAll());
  const firstContents = readFileSync(path, "utf8");
  const nextRoot = join(scope.runRoot, "next-workflow");
  const clearBehavior = t.mock.method(JarvisBehaviorToolStore.prototype, "clear");
  const aborted = domain.prepareWorkflow(
    { workflowId: "workflow-002", status: "active", checkpointSeq: 0 },
    nextRoot,
  );
  assert.equal(clearBehavior.mock.callCount(), 0);
  assert.deepEqual(domain.journal.aggregate(domain.journal.readAll()).histories.map((entry) => entry.runtimeSequence), [2]);
  aborted.abort();
  assert.equal(clearBehavior.mock.callCount(), 0);
  assert.deepEqual(domain.journal.aggregate(domain.journal.readAll()).histories.map((entry) => entry.runtimeSequence), [2]);
  const change = domain.prepareWorkflow(
    { workflowId: "workflow-002", status: "active", checkpointSeq: 0 },
    nextRoot,
  );
  change.commit();
  assert.equal(clearBehavior.mock.callCount(), 1);
  change.releasePrevious();
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(3));
  assert.equal(readFileSync(path, "utf8"), firstContents);
  assert.deepEqual(readJournalEvents(join(nextRoot, "rbt-events.jsonl")), domain.journal.readAll());
  await domain.restore({ workflowId: "workflow-002", status: "active", checkpointSeq: 0 });
  assert.deepEqual(domain.journal.aggregate(domain.journal.readAll()).histories.map((entry) => entry.runtimeSequence), [3]);
  await domain.stop();
  assert.equal(existsSync(join(nextRoot, ".rbt-events.lock")), false);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history(4));
  assert.equal(readJournalEvents(join(nextRoot, "rbt-events.jsonl")).length, 1);
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

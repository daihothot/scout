import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Journal, readJournalEvents } from "../../src/core/journal/index.js";
import {
  BaseDomain,
  BaseDomainEvents,
  BaseDomainJournal,
  ScoutDomainId,
  type BaseDomainAgentToolCallObservedEvent,
} from "../../src/domain/index.js";
import { RbtEvents, RbtJournal, type RbtExecutionHistoryReadyEvent } from "../../src/domain/domains/rbt/index.js";
import type { RunScope } from "../../src/run/run-scope.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

for (const entry of [
  {
    name: "Base",
    create: (scope: RunScope) => {
      const installed = scope.domainRegistry.get(ScoutDomainId.Base);
      assert.ok(installed instanceof BaseDomain);
      installed.journal.close();
      return new BaseDomainJournal();
    },
    file: "base.journal",
    lock: ".base.lock",
    journalId: "base",
    event: {
      id: "base-stored-call",
      key: BaseDomainEvents.agentToolCall.observed,
      occurredAt: "2026-09-27T00:00:01.000Z",
      payload: {
        callId: "base-stored-call",
        agentId: "reviewer",
        role: "reviewer",
        phase: "review",
        namespace: "scout",
        tool: "execution_platform",
        arguments: { operation: "shutdown" },
        response: { success: true, contentItems: [] },
        startedAt: "2026-09-27T00:00:00.000Z",
        completedAt: "2026-09-27T00:00:01.000Z",
      } satisfies BaseDomainAgentToolCallObservedEvent,
    },
  },
  {
    name: "RBT",
    create: () => new RbtJournal(),
    file: "rbt-events.jsonl",
    lock: ".rbt-events.lock",
    journalId: "rbt",
    event: {
      id: "rbt-stored-history",
      key: RbtEvents.history.ready,
      occurredAt: "2026-09-27T00:00:01.000Z",
      payload: {
        bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
        executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
        executorHistoryRef: "history/1.json",
        executeFileRef: "execute/1.json",
        runtimeSequence: 1,
        campaignId: "campaign-1",
        scenarioId: "scenario-1",
        status: "completed",
        agentId: "executor",
        role: "executor",
      } satisfies RbtExecutionHistoryReadyEvent,
    },
  },
]) {
  test(`${entry.name} journal opens existing facts independently of Workflow startup origin`, (t) => {
    const scope = installTestRunScope(t, { runId: `${entry.name}-journal-existing` });
    const journal = entry.create(scope);
    t.after(() => journal.close());
    const path = join(scope.workflow.journalRoot, entry.file);
    const stored = Journal.create({
      journalId: entry.journalId,
      path,
      lockPath: join(scope.workflow.journalRoot, entry.lock),
    });
    t.after(() => stored.close());
    const expected = stored.append(entry.event);
    stored.close();
    const contents = readFileSync(path, "utf8");

    journal.start();

    assert.deepEqual(journal.readAll(), [expected]);
    assert.equal(readFileSync(path, "utf8"), contents);
    assert.equal(scope.workflow.snapshot()?.status, "active");
  });

  test(`${entry.name} journal creates its own missing file`, (t) => {
    const scope = installTestRunScope(t, { runId: `${entry.name}-journal-missing` });
    const journal = entry.create(scope);
    t.after(() => journal.close());
    const path = join(scope.workflow.journalRoot, entry.file);
    // The shared fixture has already installed Base Domain; remove only its empty test file.
    if (existsSync(path)) {
      assert.equal(readFileSync(path, "utf8"), "");
      unlinkSync(path);
    }
    assert.equal(existsSync(path), false);

    journal.start();

    assert.deepEqual(journal.readAll(), []);
    assert.equal(readFileSync(path, "utf8"), "");
    assert.equal(existsSync(join(scope.workflow.journalRoot, entry.lock)), true);
  });

  test(`${entry.name} journal rejects corrupt existing facts without recreating the file`, (t) => {
    const scope = installTestRunScope(t, { runId: `${entry.name}-journal-corrupt` });
    const journal = entry.create(scope);
    t.after(() => journal.close());
    const path = join(scope.workflow.journalRoot, entry.file);
    const contents = "{corrupt-complete-journal-line}\n";
    writeFileSync(path, contents, "utf8");
    const create = t.mock.method(Journal, "create");

    assert.throws(() => journal.start(), /Invalid journal JSON at line 1/);

    assert.equal(create.mock.callCount(), 0);
    assert.equal(readFileSync(path, "utf8"), contents);
    assert.equal(existsSync(join(scope.workflow.journalRoot, entry.lock)), false);
  });

  test(`${entry.name} journal rejects an attached file without recreating or releasing it`, (t) => {
    const scope = installTestRunScope(t, { runId: `${entry.name}-journal-attached` });
    const journal = entry.create(scope);
    t.after(() => journal.close());
    const path = join(scope.workflow.journalRoot, entry.file);
    const lockPath = join(scope.workflow.journalRoot, entry.lock);
    const owner = Journal.create({ journalId: entry.journalId, path, lockPath });
    t.after(() => owner.close());
    owner.append(entry.event);
    const contents = readFileSync(path, "utf8");
    const lock = readFileSync(lockPath, "utf8");
    const create = t.mock.method(Journal, "create");

    assert.throws(() => journal.start(), /already attached/);
    journal.close();

    assert.equal(create.mock.callCount(), 0);
    assert.equal(readFileSync(path, "utf8"), contents);
    assert.equal(readFileSync(lockPath, "utf8"), lock);
  });

  test(`${entry.name} journal prepares and aborts without replacing the current Workflow`, (t) => {
    const scope = installTestRunScope(t, { runId: `${entry.name}-workflow-abort` });
    const journal = entry.create(scope);
    t.after(() => journal.close());
    journal.start();
    const previousRoot = scope.workflow.journalRoot;
    const previousEvents = journal.readAll();
    assert.throws(() => journal.prepareWorkflow(previousRoot), /already attached/);
    assert.deepEqual(journal.readAll(), previousEvents);

    const nextRoot = join(scope.runRoot, "prepared-workflow");
    const change = journal.prepareWorkflow(nextRoot);
    assert.deepEqual(journal.readAll(), previousEvents);
    assert.equal(existsSync(join(previousRoot, entry.lock)), true);
    assert.equal(existsSync(join(nextRoot, entry.lock)), true);
    assert.throws(() => journal.prepareWorkflow(join(scope.runRoot, "another-workflow")), /already has a prepared/);
    assert.throws(() => change.releasePrevious(), /Cannot release the current/);
    change.abort();
    change.abort();
    assert.equal(existsSync(join(nextRoot, entry.lock)), false);
    assert.equal(existsSync(join(previousRoot, entry.lock)), true);
    assert.deepEqual(journal.readAll(), previousEvents);
    assert.throws(() => change.commit(), /inactive.*preparation/);

    const retry = journal.prepareWorkflow(nextRoot);
    retry.commit();
    assert.equal(existsSync(join(previousRoot, entry.lock)), true);
    assert.throws(() => retry.abort(), /Cannot abort a committed/);
    assert.throws(() => retry.commit(), /inactive.*preparation/);
    retry.releasePrevious();
    retry.releasePrevious();
    assert.equal(existsSync(join(previousRoot, entry.lock)), false);
    assert.equal(existsSync(join(nextRoot, entry.lock)), true);
  });

  test(`${entry.name} journal commits without closing or writing any resource`, (t) => {
    const scope = installTestRunScope(t, { runId: `${entry.name}-workflow-commit` });
    const journal = entry.create(scope);
    t.after(() => journal.close());
    journal.start();
    const nextRoot = join(scope.runRoot, "prepared-workflow");
    const change = journal.prepareWorkflow(nextRoot);
    const close = t.mock.method(Journal.prototype, "close", () => {
      throw new Error("commit must not release journal locks");
    });
    const append = t.mock.method(Journal.prototype, "append", () => {
      throw new Error("commit must not write journal events");
    });
    change.commit();
    assert.equal(close.mock.callCount(), 0);
    assert.equal(append.mock.callCount(), 0);
    assert.deepEqual(journal.readAll(), []);
    close.mock.restore();
    append.mock.restore();
    change.releasePrevious();
    assert.equal(existsSync(join(nextRoot, entry.lock)), true);
  });

  for (const committed of [false, true]) {
    test(`${entry.name} journal retains ${committed ? "previous" : "prepared"} resources after close failure`, (t) => {
      const scope = installTestRunScope(t, { runId: `${entry.name}-workflow-close-${committed}` });
      const journal = entry.create(scope);
      journal.start();
      const previousRoot = scope.workflow.journalRoot;
      const nextRoot = join(scope.runRoot, "prepared-workflow");
      const change = journal.prepareWorkflow(nextRoot);
      if (committed) change.commit();
      const failingPath = join(committed ? previousRoot : nextRoot, entry.file);
      const originalClose = Journal.prototype.close;
      const failure = new Error("journal lock release failed");
      let attempts = 0;
      const close = t.mock.method(Journal.prototype, "close", function (this: Journal) {
        if (this.path === failingPath) {
          attempts += 1;
          throw failure;
        }
        return originalClose.call(this);
      });
      const release = () => committed ? change.releasePrevious() : change.abort();
      assert.throws(release, (error) => error === failure);
      close.mock.restore();
      assert.throws(release, (error) => error === failure);
      if (!committed) assert.throws(() => change.commit(), (error) => error === failure);
      assert.throws(
        () => journal.prepareWorkflow(join(scope.runRoot, "unsafe-retry")),
        /after journal cleanup failed/,
      );
      assert.equal(attempts, 1);
      assert.equal(existsSync(join(committed ? previousRoot : nextRoot, entry.lock)), true);
      assert.throws(() => journal.close(), (error) => (
        error instanceof AggregateError && error.errors.includes(failure)
      ));
      assert.equal(existsSync(join(committed ? nextRoot : previousRoot, entry.lock)), false);
      assert.throws(() => journal.close(), /Failed to close/);
    });
  }

  test(`${entry.name} journal closes prepared and retired Workflow resources during shutdown`, (t) => {
    const scope = installTestRunScope(t, { runId: `${entry.name}-workflow-stop` });
    const journal = entry.create(scope);
    journal.start();
    const firstRoot = scope.workflow.journalRoot;
    const secondRoot = join(scope.runRoot, "second-workflow");
    const thirdRoot = join(scope.runRoot, "third-workflow");
    const committed = journal.prepareWorkflow(secondRoot);
    committed.commit();
    const pending = journal.prepareWorkflow(thirdRoot);
    journal.close();
    journal.close();
    for (const root of [firstRoot, secondRoot, thirdRoot]) {
      assert.equal(existsSync(join(root, entry.lock)), false);
    }
    pending.abort();
    committed.releasePrevious();
    assert.throws(() => pending.commit(), /inactive.*preparation/);
  });
}

test("Base Domain keeps runtime facts and tool calls until its prepared Workflow commits", async (t) => {
  const scope = installTestRunScope(t, { runId: "base-domain-prepared-state" });
  const domain = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(domain instanceof BaseDomain);
  const call: BaseDomainAgentToolCallObservedEvent = {
    callId: "base-call-1",
    agentId: "reviewer",
    role: "reviewer",
    phase: "review",
    namespace: "scout",
    tool: "execution_platform",
    arguments: { operation: "shutdown" },
    response: { success: true, contentItems: [] },
    startedAt: "2026-09-27T00:00:00.000Z",
    completedAt: "2026-09-27T00:00:01.000Z",
  };
  await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, call);
  domain.restore(scope.workflow.snapshot()!);
  const previousFact = domain.runtimeFact;
  const previousCalls = domain.toolCallStore.list();
  const previousPath = join(scope.workflow.journalRoot, "base.journal");
  const previousContents = readFileSync(previousPath, "utf8");
  const stop = t.mock.method(domain.execution, "stop");
  const nextRoot = join(scope.runRoot, "prepared-workflow");
  const workflowState = { workflowId: "workflow-002", status: "active" as const, checkpointSeq: 0 };
  const aborted = domain.prepareWorkflow(workflowState, nextRoot);
  assert.deepEqual(domain.runtimeFact, previousFact);
  assert.deepEqual(domain.toolCallStore.list(), previousCalls);
  assert.equal(stop.mock.callCount(), 0);
  aborted.abort();
  assert.deepEqual(domain.runtimeFact, previousFact);
  assert.deepEqual(domain.toolCallStore.list(), previousCalls);
  assert.equal(stop.mock.callCount(), 0);
  const change = domain.prepareWorkflow(workflowState, nextRoot);
  change.commit();
  assert.deepEqual(domain.runtimeFact, { domainId: "base", journalSeq: 0, toolCalls: [] });
  assert.deepEqual(domain.toolCallStore.list(), []);
  assert.equal(stop.mock.callCount(), 1);
  change.releasePrevious();
  assert.equal(readFileSync(previousPath, "utf8"), previousContents);
  assert.deepEqual(readJournalEvents(join(nextRoot, "base.journal")), []);
});

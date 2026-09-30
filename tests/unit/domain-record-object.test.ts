import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readJournalEvents } from "../../src/core/journal/index.js";
import { RecordableObject } from "../../src/core/record/index.js";
import { ScoutRecordObject } from "../../src/core/record/scout-record-object.js";
import { RequestHubRecordObject } from "../../src/core/requeshub/request-hub-record-object.js";
import {
  BaseDomain,
  BaseDomainEvents,
  BaseDomainRecordObject,
  DomainRecordObject,
  ScoutDomainId,
  type BaseDomainAgentToolCallObservedEvent,
} from "../../src/domain/index.js";
import { RbtEvents, RbtRecordObject, type RbtExecutionHistoryReadyEvent } from "../../src/domain/domains/rbt/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("Base and RBT inherit journal resource operations while retaining their own projections", () => {
  for (const record of [new ScoutRecordObject(), new RequestHubRecordObject()]) {
    assert.ok(record instanceof RecordableObject);
    assert.equal(record.prepareWorkflow, RecordableObject.prototype.prepareWorkflow);
  }
  for (const journal of [new BaseDomainRecordObject(), new RbtRecordObject()]) {
    assert.ok(journal instanceof DomainRecordObject);
    assert.ok(journal instanceof RecordableObject);
    const prototype = Object.getPrototypeOf(journal);
    for (const method of ["start", "stop", "write", "readAll", "prepareWorkflow", "close"] as const) {
      assert.equal(Object.hasOwn(prototype, method), false);
      assert.equal(journal[method], DomainRecordObject.prototype[method]);
    }
    assert.equal(Object.hasOwn(prototype, "project"), true);
    assert.equal(Object.hasOwn(prototype, "aggregate"), true);
  }
  const baseFact = new BaseDomainRecordObject().aggregate([]);
  const rbtFact = new RbtRecordObject().aggregate([]);
  assert.deepEqual(baseFact, { domainId: "base", journalSeq: 0, toolCalls: [] });
  assert.deepEqual(rbtFact, { domainId: "rbt", journalSeq: 0, histories: [], executionPacks: [], reviews: [] });
});

test("DomainRecordObject instances isolate subscriptions and Workflow resources without deleting historical files", async (t) => {
  const scope = installTestRunScope(t, { runId: "domain-journal-isolation" });
  const base = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  const baseJournal = base.recordObject;
  const rbtJournal = new RbtRecordObject();
  t.after(() => rbtJournal.close());
  rbtJournal.start();
  rbtJournal.start();
  const previousRoot = scope.workflow.journalRoot;
  const occurredAt = "2026-09-27T00:00:00.000Z";
  const call = {
    callId: "call-1", agentId: "reviewer", role: "reviewer", phase: "review",
    namespace: "scout", tool: "execution_platform", arguments: { operation: "shutdown" },
    response: { success: true, contentItems: [] }, startedAt: occurredAt, completedAt: occurredAt,
  } satisfies BaseDomainAgentToolCallObservedEvent;
  const history = {
    bddId: "account", targetVersion: "1.0", platform: { type: "unity-editor", version: "test" },
    executeFileDigest: `sha256:${"a".repeat(64)}`, executorHistoryDigest: `sha256:${"b".repeat(64)}`,
    executorHistoryRef: "history/1.json", executeFileRef: "execute/1.json", runtimeSequence: 1,
    campaignId: "campaign-1", scenarioId: "scenario-1", status: "completed", agentId: "executor", role: "executor",
  } satisfies RbtExecutionHistoryReadyEvent;
  await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, call, { occurredAt });
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, history, { occurredAt });
  assert.deepEqual(baseJournal.readAll().map((event) => event.key.routeKey), [BaseDomainEvents.agentToolCall.observed.routeKey]);
  assert.deepEqual(rbtJournal.readAll().map((event) => event.key.routeKey), [RbtEvents.history.ready.routeKey]);

  const nextRoot = join(scope.runRoot, "prepared-base-workflow");
  const change = baseJournal.prepareWorkflow(nextRoot);
  change.commit();
  assert.deepEqual(baseJournal.readAll(), []);
  assert.equal(rbtJournal.readAll().length, 1);
  assert.equal(existsSync(join(previousRoot, ".base.lock")), true);
  assert.equal(existsSync(join(previousRoot, ".rbt-events.lock")), true);
  change.releasePrevious();
  assert.equal(existsSync(join(previousRoot, ".base.lock")), false);
  assert.equal(existsSync(join(previousRoot, ".rbt-events.lock")), true);
  assert.equal(readJournalEvents(join(previousRoot, "base.journal")).length, 1);

  baseJournal.stop();
  const stoppedEvent = await scope.eventBus.publishAndWait(
    BaseDomainEvents.agentToolCall.observed, { ...call, callId: "call-2" }, { occurredAt },
  );
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, { ...history, runtimeSequence: 2 }, { occurredAt });
  assert.deepEqual(baseJournal.readAll(), []);
  assert.equal(rbtJournal.readAll().length, 2);
  // stop detaches the observer; explicit writes still use the owned journal.
  baseJournal.write(stoppedEvent);
  baseJournal.start();
  await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, { ...call, callId: "call-3" }, { occurredAt });
  assert.equal(baseJournal.readAll().length, 2);
  assert.equal(readJournalEvents(join(nextRoot, "base.journal")).length, 2);
  assert.equal(readJournalEvents(join(previousRoot, "base.journal")).length, 1);

  baseJournal.close();
  assert.equal(existsSync(join(nextRoot, ".base.lock")), false);
  assert.equal(existsSync(join(previousRoot, ".rbt-events.lock")), true);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, { ...history, runtimeSequence: 3 }, { occurredAt });
  assert.equal(rbtJournal.readAll().length, 3);
  rbtJournal.close();
  assert.equal(existsSync(join(previousRoot, ".rbt-events.lock")), false);
  assert.equal(readJournalEvents(join(previousRoot, "rbt-events.jsonl")).length, 3);
  assert.equal(readJournalEvents(join(previousRoot, "base.journal")).length, 1);
  assert.equal(readJournalEvents(join(nextRoot, "base.journal")).length, 2);
});

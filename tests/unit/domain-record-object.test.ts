import { RbtDomainProjector } from "../../src/domain/domains/rbt/index.js";
import { BaseDomainProjector } from "../../src/domain/domains/base/index.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readJournalEvents } from "../../src/core/journal/index.js";
import {
  BaseDomain,
  BaseDomainEvents,
  ScoutDomainId,
  type BaseDomainAgentToolCallObservedEvent,
} from "../../src/domain/index.js";
import { RbtEvents, RbtRecordObject, type RbtExecutionHistoryReadyEvent } from "../../src/domain/domains/rbt/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";


test("DomainRecordObject instances isolate subscriptions and Workflow resources without deleting historical files", async (t) => {
  const scope = await installTestRunScope(t, { runId: "domain-journal-isolation" });
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
  assert.deepEqual(baseJournal.read().map((event) => event.key.routeKey), [BaseDomainEvents.agentToolCall.observed.routeKey]);
  assert.deepEqual(rbtJournal.read().map((event) => event.key.routeKey), [RbtEvents.history.ready.routeKey]);

  const nextRoot = join(scope.runRoot, "prepared-base-workflow");
  const change = baseJournal.prepare(nextRoot);
  change.commit();
  assert.deepEqual(baseJournal.read(), []);
  assert.equal(rbtJournal.read().length, 1);
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
  assert.deepEqual(baseJournal.read(), []);
  assert.equal(rbtJournal.read().length, 2);
  // stop detaches the observer; explicit writes still use the owned journal.
  baseJournal.write(stoppedEvent);
  baseJournal.start();
  await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, { ...call, callId: "call-3" }, { occurredAt });
  assert.equal(baseJournal.read().length, 2);
  assert.equal(readJournalEvents(join(nextRoot, "base.journal")).length, 2);
  assert.equal(readJournalEvents(join(previousRoot, "base.journal")).length, 1);

  baseJournal.close();
  assert.equal(existsSync(join(nextRoot, ".base.lock")), false);
  assert.equal(existsSync(join(previousRoot, ".rbt-events.lock")), true);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, { ...history, runtimeSequence: 3 }, { occurredAt });
  assert.equal(rbtJournal.read().length, 3);
  rbtJournal.close();
  assert.equal(existsSync(join(previousRoot, ".rbt-events.lock")), false);
  assert.equal(readJournalEvents(join(previousRoot, "rbt-events.jsonl")).length, 3);
  assert.equal(readJournalEvents(join(previousRoot, "base.journal")).length, 1);
  assert.equal(readJournalEvents(join(nextRoot, "base.journal")).length, 2);
});

test("Base and RBT decode their persisted contracts before Projectors reconstruct isolated runtime facts", async (t) => {
  const scope = await installTestRunScope(t, { runId: "domain-record-decoding" });
  const base = scope.domainRegistry.get(ScoutDomainId.Base);
  assert.ok(base instanceof BaseDomain);
  const rbt = new RbtRecordObject();
  rbt.start();
  t.after(() => rbt.close());
  const at = new Date().toISOString();
  await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, {
    callId: "call", agentId: "executor", role: "executor", phase: "execute",
    namespace: "test", tool: "Probe", arguments: {}, response: { success: true, contentItems: [] },
    startedAt: at, completedAt: at,
  } satisfies BaseDomainAgentToolCallObservedEvent);
  await scope.eventBus.publishAndWait(RbtEvents.history.ready, {
    bddId: "account", targetVersion: "1.0", platform: { type: "android", version: "34" },
    executeFileDigest: "sha256:" + "a".repeat(64), executorHistoryDigest: "sha256:" + "b".repeat(64),
    executorHistoryRef: "history/1.json", executeFileRef: "account/execute-file.json", runtimeSequence: 1,
    campaignId: "campaign", scenarioId: "scenario", status: "completed", agentId: "executor", role: "executor",
  } satisfies RbtExecutionHistoryReadyEvent);
  const baseRecords = base.recordObject.read();
  const baseFact = new BaseDomainProjector().project(baseRecords);
  const rbtRecords = rbt.read();
  const rbtFact = new RbtDomainProjector().project(rbtRecords);
  assert.equal(baseFact.toolCalls[0]?.callId, "call");
  assert.equal(rbtFact.histories[0]?.runtimeSequence, 1);
  Object.assign(baseRecords[0]!.payload, { callId: "changed" });
  Object.assign(rbtRecords[0]!.payload, { runtimeSequence: 99 });
  assert.equal(baseFact.toolCalls[0]?.callId, "call");
  assert.equal(rbtFact.histories[0]?.runtimeSequence, 1);

  const basePath = base.recordObject.path;
  const root = scope.workflow.journalRoot;
  const baseContents = readFileSync(basePath, "utf8");
  const badCall = JSON.parse(baseContents);
  badCall.payload.response.success = "true";
  base.recordObject.close();
  writeFileSync(basePath, JSON.stringify(badCall) + "\n");
  base.recordObject.open(root);
  assert.throws(() => base.recordObject.read(), /Invalid Base record.*response.success/);
  base.recordObject.close();
  writeFileSync(basePath, baseContents);
  base.recordObject.open(root);
  const rbtPath = rbt.path;
  const rbtContents = readFileSync(rbtPath, "utf8");
  const badHistory = JSON.parse(rbtContents);
  badHistory.payload.runtimeSequence = "1";
  rbt.close();
  writeFileSync(rbtPath, JSON.stringify(badHistory) + "\n");
  rbt.open(root);
  assert.throws(() => rbt.read(), /Invalid RBT record.*runtimeSequence/);
  rbt.close();
  writeFileSync(rbtPath, rbtContents);
  rbt.open(root);
});

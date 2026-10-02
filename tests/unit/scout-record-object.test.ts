import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AssetStore } from "../../src/asset-store/index.js";
import { InMemoryEventBus, type ScoutEvent } from "../../src/core/events/index.js";
import { Journal } from "../../src/core/journal/index.js";
import { Logger } from "../../src/core/logging/index.js";
import { ScoutRecordObject } from "../../src/core/record/scout-record-object.js";
import { WorkflowEvents } from "../../src/core/workflow/workflow-events.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/index.js";
import { RunEvents } from "../../src/run/events/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import { installRunScope, RunScope } from "../../src/run/run-scope.js";

test("ScoutRecordObject records Workflow facts explicitly once, not again on broadcast", async (t) => {
  const { scout, eventBus } = createScoutRecordObject(t);
  const state = {
    domain: "rbt",
    workflowProfile: "rbt",
    currentPhase: "execute",
    phases: [{ name: "execute", edges: { completed: null, error: null }, roles: ["worker"] }],
    roles: [{ name: "worker", phases: ["execute"] }],
  };
  const initializedAt = "2026-09-27T00:00:00.000Z";
  const initialized = {
    id: "initialized",
    key: WorkflowEvents.workflow.initialized,
    occurredAt: initializedAt,
    payload: { state, initializedAt },
  };
  const advanced = {
    id: "advanced",
    key: WorkflowEvents.workflow.advanced,
    occurredAt: initializedAt,
    payload: {
      state,
      previousPhase: "execute",
      outcome: "completed",
      cycleCompleted: true,
      advancedAt: initializedAt,
    },
  };
  for (const event of [initialized, advanced]) {
    scout.write(event);
    await eventBus.publishAndWait(event.key, event.payload, {
      id: event.id,
      occurredAt: event.occurredAt,
    });
  }

  assert.deepEqual(scout.read().map((event) => event.id), ["initialized", "advanced"]);
  await eventBus.publishAndWait(RunEvents.runtime.attached, {
    mode: "start",
    attachedAt: initializedAt,
    processId: process.pid,
  });
  assert.equal(scout.lastSeq, 3);
});

test("ScoutRecordObject explicit write failures are retried, disclosed, and remain retryable", (t) => {
  const { scout, eventBus } = createScoutRecordObject(t);
  const append = Journal.prototype.append;
  const failure = new Error("injected append failure");
  let unavailable = true;
  let attempts = 0;
  let disclosed = 0;
  eventBus.subscribe(RunEvents.journal.writeFailed, () => { disclosed += 1; });
  t.mock.method(Journal.prototype, "append", function (this: Journal, event: ScoutEvent) {
    attempts += 1;
    if (unavailable) throw failure;
    return append.call(this, event);
  });

  assert.throws(() => scout.write(runCreated()), (error) => error === failure);
  assert.equal(attempts, 2);
  assert.equal(disclosed, 1);
  assert.equal(scout.lastSeq, 0);
  assert.throws(() => scout.write(runCreated()), (error) => error === failure);
  assert.equal(disclosed, 1);

  unavailable = false;
  assert.equal(scout.write(runCreated()).seq, 1);
  unavailable = true;
  assert.throws(() => scout.write(runCreated()), (error) => error === failure);
  assert.equal(disclosed, 2);
});

test("ScoutRecordObject create accepts the Run baseline before strict Workflow initialization", (t) => {
  const { scout } = createScoutRecordObject(t, [runCreated()]);
  assert.equal(scout.lastSeq, 1);
  assert.equal(scout.read()[0]?.id, "run-created");
  assert.equal(scout.hasPreparedRecords, false);
});

test("Scout record read rejects malformed persisted payloads before projection", (t) => {
  const { scout } = createScoutRecordObject(t, [runCreated()]);
  const root = scout.journalRoot;
  const path = scout.path;
  const contents = readFileSync(path, "utf8");
  const external = JSON.parse(contents);
  external.payload.runId = 42;
  scout.close();
  writeFileSync(path, JSON.stringify(external) + "\n");
  scout.open(root);
  assert.throws(() => scout.read(), /Invalid Scout record.*runId/);
  assert.throws(() => ScoutRecordObject.readFile(path), /Invalid Scout record.*runId/);
  scout.close();
  writeFileSync(path, contents);
  scout.open(root);
  assert.equal(scout.read()[0]?.id, "run-created");
});

test("ScoutRecordObject activation only swaps handles and releases the previous journal separately", (t) => {
  const { scout, root } = createScoutRecordObject(t);
  const oldRoot = scout.journalRoot;
  const oldPath = scout.path;
  const close = Journal.prototype.close;
  let oldCloses = 0;
  t.mock.method(Journal.prototype, "close", function (this: Journal) {
    if (this.path === oldPath) oldCloses += 1;
    return close.call(this);
  });
  const prepared = scout.prepare(join(root, "workflow-002"), [runCreated()]);
  assert.equal(scout.hasPreparedRecords, true);

  prepared.commit();

  assert.equal(scout.journalRoot, prepared.journalRoot);
  assert.equal(scout.hasPreparedRecords, false);
  assert.equal(oldCloses, 0);
  assert.equal(existsSync(join(oldRoot, ".scout.lock")), true);
  assert.equal(scout.write({ ...runCreated(), id: "next" }).seq, 2);
  scout.releasePrevious();
  scout.releasePrevious();
  assert.equal(oldCloses, 1);
  assert.equal(existsSync(join(oldRoot, ".scout.lock")), false);
});

test("ScoutRecordObject discard retains failed close ownership and never mistakes a later no-op for release", (t) => {
  const fixture = createScoutRecordObject(t);
  const { scout, root } = fixture;
  const activeRoot = scout.journalRoot;
  const prepared = scout.prepare(join(root, "workflow-002"), []);
  const failure = new Error("lock release failed after Journal became closed");
  let closes = 0;
  const close = Journal.prototype.close;
  t.mock.method(Journal.prototype, "close", function (this: Journal) {
    if (this.path !== join(prepared.journalRoot, "scout.journal")) return close.call(this);
    closes += 1;
    if (closes === 1) throw failure;
  });
  fixture.expectCloseFailure = true;

  assert.throws(() => prepared.abort(), (error) => error === failure);
  assert.equal(scout.hasPreparedRecords, true);
  assert.throws(() => prepared.abort(), (error) => error === failure);
  assert.throws(() => prepared.commit(), (error) => error === failure);
  assert.equal(closes, 1);
  assert.throws(() => scout.stop(), AggregateError);
  assert.equal(existsSync(join(activeRoot, ".scout.lock")), false);
  assert.equal(scout.hasPreparedRecords, true);
  assert.equal(closes, 1);
});

test("ScoutRecordObject prepare failure closes the candidate and leaves the active journal usable", (t) => {
  const { scout, root } = createScoutRecordObject(t);
  const failure = new Error("baseline write failure");
  t.mock.method(Journal.prototype, "replaceAll", () => { throw failure; });
  const nextRoot = join(root, "workflow-002");

  assert.throws(() => scout.prepare(nextRoot, []), (error) => error === failure);
  assert.equal(scout.hasPreparedRecords, false);
  assert.equal(existsSync(join(nextRoot, ".scout.lock")), false);
  assert.equal(scout.write(runCreated()).seq, 1);
});

test("ScoutRecordObject prepare retains a candidate whose baseline and close both failed", (t) => {
  const fixture = createScoutRecordObject(t);
  const { scout, root } = fixture;
  const nextRoot = join(root, "workflow-002");
  const appendFailure = new Error("baseline failure");
  const closeFailure = new Error("candidate close failure");
  const close = Journal.prototype.close;
  let failedCloses = 0;
  t.mock.method(Journal.prototype, "replaceAll", () => { throw appendFailure; });
  t.mock.method(Journal.prototype, "close", function (this: Journal) {
    if (this.path === join(nextRoot, "scout.journal")) {
      failedCloses += 1;
      if (failedCloses === 1) throw closeFailure;
      return;
    }
    return close.call(this);
  });
  fixture.expectCloseFailure = true;

  assert.throws(() => scout.prepare(nextRoot, []), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [appendFailure, closeFailure]);
    return true;
  });
  assert.equal(scout.hasPreparedRecords, true);
  assert.throws(() => scout.stop(), AggregateError);
  assert.equal(failedCloses, 1);
});

test("ScoutRecordObject retains a failed retired close without changing the newly active journal", (t) => {
  const fixture = createScoutRecordObject(t);
  const { scout, root } = fixture;
  const oldPath = scout.path;
  const close = Journal.prototype.close;
  let oldCloses = 0;
  t.mock.method(Journal.prototype, "close", function (this: Journal) {
    if (this.path === oldPath) {
      oldCloses += 1;
      if (oldCloses === 1) throw new Error("retired lock release failure");
      return;
    }
    return close.call(this);
  });
  fixture.expectCloseFailure = true;
  const prepared = scout.prepare(join(root, "workflow-002"), []);
  prepared.commit();

  assert.throws(() => scout.releasePrevious(), AggregateError);
  assert.throws(() => scout.releasePrevious(), AggregateError);
  assert.equal(oldCloses, 1);
  assert.equal(scout.journalRoot, prepared.journalRoot);
  assert.equal(scout.write(runCreated()).seq, 1);
  assert.throws(() => scout.stop(), AggregateError);
  assert.equal(existsSync(join(prepared.journalRoot, ".scout.lock")), false);
});

function createScoutRecordObject(t: TestContext, baseline?: readonly ScoutEvent[]) {
  const root = mkdtempSync(join(tmpdir(), "scout-journal-owned-"));
  const runId = "scout-journal-test";
  const runRoot = join(root, "run", runId);
  const eventBus = new InMemoryEventBus();
  const scope = new RunScope({
    runId,
    scoutRoot: root,
    runRoot,
    logger: new Logger({ runId, logsRoot: join(runRoot, "logs") }),
    eventBus,
    interactionPort: new NoopRuntimeInteractionPort(),
    config: new AssetStore().config(root),
    manifestStore: new RunManifestStore(runRoot),
    terminate: async () => undefined,
  });
  const release = installRunScope(scope);
  const scout = new ScoutRecordObject();
  scout.create(join(root, "workflow-001"), baseline);
  scout.start();
  const fixture = { root, eventBus, scout, expectCloseFailure: false };
  t.after(() => {
    try {
      if (fixture.expectCloseFailure) assert.throws(() => scout.stop(), AggregateError);
      else scout.stop();
    } finally {
      release();
      rmSync(root, { recursive: true, force: true });
    }
  });
  return fixture;
}

function runCreated(): ScoutEvent {
  const createdAt = "2026-09-27T00:00:00.000Z";
  return {
    id: "run-created",
    key: RunEvents.run.created,
    occurredAt: createdAt,
    payload: { runId: "scout-journal-test", scoutRoot: "/fixture", createdAt },
  };
}

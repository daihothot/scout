import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { InMemoryEventBus, type ScoutEvent } from "../../src/core/events/index.js";
import { Journal, JournalWriter, type JournalWriteFailure } from "../../src/core/journal/index.js";
import { RunEvents } from "../../src/run/events/index.js";

test("JournalWriter explicit writes retry once and return the recorded fact", (t) => {
  const { journal, writer, failures, successes } = createWriter(t);
  const append = journal.append.bind(journal);
  let attempts = 0;
  t.mock.method(journal, "append", (event: ScoutEvent) => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient write failure");
    return append(event);
  });

  const recorded = writer.write(runtimeAttached());

  assert.equal(attempts, 2);
  assert.equal(recorded.seq, 1);
  assert.equal(recorded.id, "attached");
  assert.equal(journal.lastSeq, 1);
  assert.deepEqual(failures, []);
  assert.equal(successes.length, 1);
});

test("JournalWriter explicit failure reports both attempts and throws the persistence error", (t) => {
  const { journal, writer, failures, successes } = createWriter(t);
  const failure = new Error("persistent write failure");
  let attempts = 0;
  t.mock.method(journal, "append", () => {
    attempts += 1;
    throw failure;
  });

  assert.throws(() => writer.write(runtimeAttached()), (error) => error === failure);
  assert.equal(attempts, 2);
  assert.equal(journal.lastSeq, 0);
  assert.equal(successes.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.error, failure);
  assert.equal(failures[0]?.journalId, journal.journalId);
});

test("JournalWriter observational failure does not reject dispatch or skip downstream observers", async (t) => {
  const { eventBus, journal, writer, failures } = createWriter(t);
  writer.start();
  t.mock.method(journal, "append", () => { throw new Error("read-only journal"); });
  let observed = 0;
  eventBus.subscribe(RunEvents.runtime.attached, () => { observed += 1; });

  await eventBus.publishAndWait(RunEvents.runtime.attached, runtimeAttached().payload);

  assert.equal(failures.length, 1);
  assert.equal(observed, 1);
  assert.equal(journal.lastSeq, 0);
});

test("JournalWriter failure disclosure cannot replace the explicit persistence error", (t) => {
  const { eventBus, journal } = createWriter(t);
  const failure = new Error("append failure");
  t.mock.method(journal, "append", () => { throw failure; });
  const writer = new JournalWriter({
    eventBus,
    eventTypes: [],
    journal: () => journal,
    onFailure: () => { throw new Error("logger failure"); },
  });

  assert.throws(() => writer.write(runtimeAttached()), (error) => error === failure);
});

test("JournalWriter required recording rejects before downstream consumers and preserves the write error", async (t) => {
  const { eventBus, journal } = createWriter(t);
  const error = new Error("required recording failed");
  const writer = new JournalWriter({ eventBus, journal: () => journal,
    eventTypes: [RunEvents.runtime.attached], required: true });
  writer.start();
  t.after(() => writer.stop());
  t.mock.method(journal, "append", () => { throw error; });
  let consumed = false;
  eventBus.subscribe(RunEvents.runtime.attached, () => { consumed = true; });
  await assert.rejects(eventBus.publishAndWait(RunEvents.runtime.attached, runtimeAttached().payload), (failure) => failure === error);
  assert.equal(consumed, false);
});

function createWriter(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "scout-journal-writer-"));
  const eventBus = new InMemoryEventBus();
  const journal = Journal.create({
    journalId: "test:writer",
    path: join(root, "scout.journal"),
    lockPath: join(root, ".scout.lock"),
  });
  const failures: JournalWriteFailure[] = [];
  const successes: true[] = [];
  const writer = new JournalWriter({
    eventBus,
    eventTypes: [RunEvents.runtime.attached],
    journal: () => journal,
    onSuccess: () => { successes.push(true); },
    onFailure: (failure) => { failures.push(failure); },
  });
  t.after(() => {
    writer.stop();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { eventBus, journal, writer, failures, successes };
}

function runtimeAttached(): ScoutEvent {
  const attachedAt = "2026-09-27T00:00:00.000Z";
  return {
    id: "attached",
    key: RunEvents.runtime.attached,
    occurredAt: attachedAt,
    payload: { mode: "start", attachedAt, processId: process.pid },
  };
}

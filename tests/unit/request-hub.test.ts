import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, readJournalEvents } from "../../src/core/journal/index.js";
import { RequestHubEvents } from "../../src/core/requeshub/request-hub-events.js";
import { RequestHub, type RequestType } from "../../src/core/requeshub/index.js";
import { requestHubJournalPaths } from "../../src/core/path.js";
import { Workflow } from "../../src/core/workflow/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import { createDefaultTestGraph, installTestRunScope, createTestWorkflowAsset } from "../helpers/run-persistence.js";

const calculation: RequestType<{ input: number }, { output: number }> = {
  name: "calculation",
  isPayload: (value): value is { input: number } => "input" in value && typeof value.input === "number",
  isResult: (value): value is { output: number } => "output" in value && typeof value.output === "number",
};
const selection: RequestType<{ choices: string[] }, { choice: string }> = {
  name: "selection",
  isPayload: (value): value is { choices: string[] } => "choices" in value && Array.isArray(value.choices)
    && value.choices.every((choice) => typeof choice === "string"),
  isResult: (value): value is { choice: string } => "choice" in value && typeof value.choice === "string",
};

async function createTestHub(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "scout-request-hub-test-"));
  const scope = await installTestRunScope(t, { runId: "request-hub", scoutRoot: root, runRoot: join(root, "run", "request-hub") });
  const location = { journalId: `${scope.runId}:request-hub`, path: join(scope.workflow.journalRoot, "request-hub.journal"), lockPath: join(scope.workflow.journalRoot, ".request-hub.lock") };
  const hubs: RequestHub[] = [];
  const open = () => {
    const hub = new RequestHub();
    hubs.push(hub);
    hub.start();
    scope.workflow.registerParticipant(hub);
    return hub;
  };
  t.after(() => {
    for (const hub of hubs) {
      hub.stop();
      if (scope.workflow.participants.includes(hub)) scope.workflow.unregisterParticipant(hub);
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { hub: open(), location, open, scope };
}

test("RequestHub keeps unrelated typed requests and rejects a mismatched contract", async (t) => {
  const { hub } = await createTestHub(t);
  const first = hub.register(calculation, { input: 4 });
  const second = hub.register(selection, { choices: ["a", "b"] });
  assert.equal(hub.get(selection, first.requestId), undefined);
  assert.equal(hub.get({ ...calculation }, first.requestId), undefined);
  assert.throws(() => hub.register({ ...calculation }, { input: 5 }), /contract already bound/);
  assert.throws(() => hub.complete(selection, first.requestId, { choice: "a" }), /Unknown/);
  await hub.complete(calculation, first.requestId, { output: 8 });
  await hub.complete(selection, second.requestId, { choice: "b" });
  const completed = hub.get(calculation, first.requestId)!;
  assert.equal(completed.status, "completed");
  if (completed.status !== "completed") throw new Error("Expected completed request.");
  assert.deepEqual(completed.result, { output: 8 });
});

test("RequestHub isolates registration, lookup, result, and callback data", async (t) => {
  const { hub } = await createTestHub(t);
  const payload = { choices: ["a"] };
  const registered = hub.register(selection, payload, { callback: (result) => { result.choice = "changed"; } });
  payload.choices.push("outside");
  registered.payload.choices.push("snapshot");
  assert.deepEqual(hub.get(selection, registered.requestId)?.payload.choices, ["a"]);
  const result = { choice: "a" };
  const completion = hub.complete(selection, registered.requestId, result);
  result.choice = "outside";
  await completion;
  const stored = hub.get(selection, registered.requestId)!;
  assert.equal(stored.status, "completed");
  if (stored.status !== "completed") throw new Error("Expected completed request.");
  assert.equal(stored.result.choice, "a");
  stored.result.choice = "snapshot";
  assert.notDeepEqual(hub.get(selection, registered.requestId), stored);
});

test("RequestHub commits before callback and never replays failed callbacks", async (t) => {
  const { hub, open } = await createTestHub(t);
  let calls = 0;
  const registered = hub.register(calculation, { input: 1 }, { callback: () => {
    calls += 1;
    assert.equal(hub.get(calculation, registered.requestId)?.status, "completed");
    throw new Error("callback failure");
  } });
  const completion = hub.complete(calculation, registered.requestId, { output: 2 });
  assert.equal(hub.get(calculation, registered.requestId)?.status, "completed");
  assert.throws(() => hub.complete(calculation, registered.requestId, { output: 3 }), /completed/);
  await assert.rejects(completion, /callback failure/);
  assert.equal(calls, 1);
  assert.equal(hub.expire(registered.requestId, "too_late"), false);
  hub.stop();
  const restored = open();
  assert.deepEqual(restored.get(calculation, registered.requestId), hub.get(calculation, registered.requestId));
  assert.equal(calls, 1);
});

test("RequestHub preserves pending requests on close and restores explicit expiry", async (t) => {
  const { hub, open, location } = await createTestHub(t);
  let callbacks = 0;
  const pending = hub.register(calculation, { input: 1 }, { callback: () => { callbacks += 1; } });
  const completed = hub.register(calculation, { input: 2 });
  const expired = hub.register(calculation, { input: 3 });
  await hub.complete(calculation, completed.requestId, { output: 4 });
  assert.equal(hub.expire(expired.requestId, "consumer_cancelled"), true);
  assert.equal(hub.expire(expired.requestId, "again"), false);
  assert.equal(hub.expire("missing", "test"), false);
  const events = readJournalEvents(location.path);
  hub.stop();
  hub.stop();
  assert.equal(existsSync(location.lockPath), false);
  assert.deepEqual(readJournalEvents(location.path), events);
  assert.equal(hub.get(calculation, pending.requestId)?.status, "pending");
  assert.equal(hub.get(calculation, completed.requestId)?.status, "completed");
  assert.equal(callbacks, 0);
  assert.throws(() => hub.register(calculation, { input: 3 }), /closed/);
  assert.throws(() => hub.complete(calculation, pending.requestId, { output: 2 }), /closed/);
  assert.throws(() => hub.expire(pending.requestId, "after_close"), /closed/);
  const restored = open();
  for (const request of [pending, completed, expired]) {
    assert.deepEqual(restored.get(calculation, request.requestId), hub.get(calculation, request.requestId));
  }
  await restored.complete(calculation, pending.requestId, { output: 2 });
  assert.equal(callbacks, 0, "Callbacks are process-local and are not deserialized.");
  assert.throws(() => restored.complete(calculation, expired.requestId, { output: 6 }), /expired/);
});

test("RequestHub validates actual data without committing malformed payloads or results", async (t) => {
  const { hub } = await createTestHub(t);
  // @ts-expect-error A request contract rejects another payload type at compile time too.
  assert.throws(() => hub.register(calculation, { choices: ["a"] }), /payload/);
  const pending = hub.register(calculation, { input: 1 });
  // @ts-expect-error The result must match the selected contract.
  assert.throws(() => hub.complete(calculation, pending.requestId, { choice: "a" }), /result/);
  assert.equal(hub.get(calculation, pending.requestId)?.status, "pending");
});

test("Multiple consumption appends independent results, restores them, and retains them on expiry", async (t) => {
  const { hub, open, location } = await createTestHub(t);
  const callbacks: number[] = [];
  const registered = hub.register(calculation, { input: 1 }, {
    consumption: "multiple", callback: ({ output }) => { callbacks.push(output); },
  });
  assert.equal(registered.consumption, "multiple");
  await hub.complete(calculation, registered.requestId, { output: 2 });
  await hub.complete(calculation, registered.requestId, { output: 3 });
  const before = hub.get(calculation, registered.requestId)!;
  if (before.consumption !== "multiple") throw new Error("Expected multiple consumption.");
  assert.equal(before.status, "pending");
  assert.deepEqual(before.completions.map(({ result }) => result.output), [2, 3]);
  assert.equal(new Set(before.completions.map(({ completionId }) => completionId)).size, 2);
  assert.deepEqual(callbacks, [2, 3]);
  hub.stop();
  const restored = open();
  assert.deepEqual(restored.get(calculation, registered.requestId), before);
  await restored.complete(calculation, registered.requestId, { output: 4 });
  assert.equal(restored.expire(registered.requestId, "workflow_finished"), true);
  assert.throws(() => restored.complete(calculation, registered.requestId, { output: 5 }), /expired/);
  const expired = restored.get(calculation, registered.requestId)!;
  if (expired.consumption !== "multiple" || expired.status !== "expired") throw new Error("Expected expired multiple-consumption request.");
  assert.equal(expired.reason, "workflow_finished");
  assert.deepEqual(expired.completions.map(({ result }) => result.output), [2, 3, 4]);
  assert.deepEqual(callbacks, [2, 3]);
  restored.stop();
  assert.deepEqual(open().get(calculation, registered.requestId), expired);
  assert.deepEqual(readJournalEvents(location.path).map(({ key }) => key.routeKey), [
    RequestHubEvents.requestHub.registered.routeKey,
    RequestHubEvents.requestHub.completed.routeKey,
    RequestHubEvents.requestHub.completed.routeKey,
    RequestHubEvents.requestHub.completed.routeKey,
    RequestHubEvents.requestHub.expired.routeKey,
  ]);
});

test("A failed callback cannot roll back or mutate multiple-consumption records", async (t) => {
  const { hub } = await createTestHub(t);
  const registered = hub.register(selection, { choices: ["a", "b"] }, { consumption: "multiple", callback: (result) => {
    result.choice = "changed";
    throw new Error("callback failure");
  } });
  await assert.rejects(hub.complete(selection, registered.requestId, { choice: "a" }), /callback failure/);
  await assert.rejects(hub.complete(selection, registered.requestId, { choice: "b" }), /callback failure/);
  const snapshot = hub.get(selection, registered.requestId)!;
  if (snapshot.consumption !== "multiple") throw new Error("Expected multiple consumption.");
  assert.deepEqual(snapshot.completions.map(({ result }) => result.choice), ["a", "b"]);
  snapshot.completions[0]!.result.choice = "outside";
  assert.notDeepEqual(hub.get(selection, registered.requestId), snapshot);
});

test("Journal append failures leave registration, completion, expiry, and callbacks uncommitted", async (t) => {
  const { hub, location } = await createTestHub(t);
  let callbacks = 0;
  const registered = hub.register(calculation, { input: 1 }, { consumption: "multiple", callback: () => { callbacks += 1; } });
  const original = hub.get(calculation, registered.requestId);
  const originalEvents = readJournalEvents(location.path);
  const fault = t.mock.method(Journal.prototype, "append", () => { throw new Error("disk unavailable"); });
  assert.throws(() => hub.register(calculation, { input: 2 }), /disk unavailable/);
  assert.throws(() => hub.complete(calculation, registered.requestId, { output: 2 }), /disk unavailable/);
  assert.throws(() => hub.expire(registered.requestId, "cancel"), /disk unavailable/);
  await Promise.resolve();
  assert.equal(callbacks, 0);
  assert.deepEqual(hub.get(calculation, registered.requestId), original);
  assert.deepEqual(readJournalEvents(location.path), originalEvents);
  fault.mock.restore();
  await hub.complete(calculation, registered.requestId, { output: 2 });
  assert.equal(callbacks, 1);
  assert.equal(hub.expire(registered.requestId, "cancel"), true);
});

test("RequestHub rejects lossy JSON payloads and results before recording them", async (t) => {
  const { hub, location } = await createTestHub(t);
  const data: RequestType<object, object> = {
    name: "json", isPayload: (value): value is object => typeof value === "object",
    isResult: (value): value is object => typeof value === "object",
  };
  const request = hub.register(data, { valid: ["text", 1, null, true] });
  for (const invalid of [{ value: undefined }, { value: Infinity }, { date: new Date() }, { map: new Map() }, [undefined]]) {
    assert.throws(() => hub.register(data, invalid), /lossless JSON/);
    assert.throws(() => hub.complete(data, request.requestId, invalid), /lossless JSON/);
  }
  assert.equal(readJournalEvents(location.path).length, 1);
});

test("Restore validates payloads and every result against the supplied host contract before rebinding", async (t) => {
  const { hub, open } = await createTestHub(t);
  const request = hub.register(calculation, { input: 1 }, { consumption: "multiple" });
  await hub.complete(calculation, request.requestId, { output: 2 });
  hub.stop();
  const restored = open();
  const wrongPayload: RequestType<{ input: number }, { output: number }> = {
    ...calculation, isPayload: (value): value is { input: number } => "input" in value && value.input === 99,
  };
  const wrongResult: RequestType<{ input: number }, { output: number }> = {
    ...calculation, isResult: (value): value is { output: number } => "output" in value && value.output === 99,
  };
  assert.throws(() => restored.get(wrongPayload, request.requestId), /stored calculation payload/);
  assert.throws(() => restored.complete(wrongResult, request.requestId, { output: 99 }), /stored calculation result/);
  assert.deepEqual(restored.get(calculation, request.requestId), hub.get(calculation, request.requestId));
  assert.equal(restored.get({ ...calculation }, request.requestId), undefined);
});

test("RequestHub refuses invalid replay transitions and releases its Journal lock on startup failure", async (t) => {
  for (const corruption of ["duplicate_registration", "after_completion", "unknown_request", "unknown_event"]) {
    await t.test(corruption, async (t) => {
      const { hub, open, location } = await createTestHub(t);
      const request = hub.register(calculation, { input: 1 });
      hub.stop();
      const journal = Journal.open(location);
      const occurredAt = new Date().toISOString();
      const completed = { requestId: request.requestId, result: { output: 2 } };
      if (corruption === "duplicate_registration") {
        journal.append({ id: "duplicate", key: RequestHubEvents.requestHub.registered, occurredAt,
          payload: { requestId: request.requestId, type: calculation.name, consumption: "single", payload: { input: 1 } } });
      } else if (corruption === "after_completion") {
        journal.append({ id: "completed", key: RequestHubEvents.requestHub.completed, occurredAt, payload: completed });
        journal.append({ id: "again", key: RequestHubEvents.requestHub.completed, occurredAt, payload: completed });
      } else if (corruption === "unknown_request") {
        journal.append({ id: "unknown", key: RequestHubEvents.requestHub.completed, occurredAt, payload: { ...completed, requestId: "missing" } });
      } else {
        journal.append({ id: "unknown", key: { ...RequestHubEvents.requestHub.completed, routeKey: "system.request_hub.unknown" }, occurredAt, payload: completed });
      }
      journal.close();
      assert.throws(open, /already registered|not pending|Unknown RequestHub event/);
      assert.equal(existsSync(location.lockPath), false);
    });
  }
});

test("RequestHub requires startup and refuses a second live writer", async (t) => {
  const { hub, location, open } = await createTestHub(t);
  assert.throws(open, /already attached/);
  hub.start();
  const unstarted = new RequestHub();
  assert.throws(() => unstarted.register(calculation, { input: 1 }), /not started/);
  unstarted.stop();
  assert.throws(() => unstarted.start(), /closed/);
});

test("RequestHub rejects malformed registration, completion, and expiry facts during replay", async (t) => {
  const invalidFacts = [
    { key: RequestHubEvents.requestHub.registered, payload: { requestId: "invalid", type: "calculation", consumption: "unlimited", payload: { input: 1 } } },
    { key: RequestHubEvents.requestHub.registered, payload: { requestId: "invalid", type: "calculation", consumption: "single", payload: null } },
    { key: RequestHubEvents.requestHub.completed, payload: { requestId: "pending", result: null } },
    { key: RequestHubEvents.requestHub.expired, payload: { requestId: "pending", reason: "" } },
  ];
  for (const [index, invalid] of invalidFacts.entries()) {
    await t.test(`invalid fact ${index + 1}`, async (t) => {
      const { hub, location, open } = await createTestHub(t);
      const pending = hub.register(calculation, { input: 1 });
      hub.stop();
      const journal = Journal.open(location);
      journal.append({ id: `invalid-${index}`, occurredAt: new Date().toISOString(), key: invalid.key,
        payload: { ...invalid.payload, requestId: invalid.payload.requestId === "pending" ? pending.requestId : invalid.payload.requestId } });
      journal.close();
      assert.throws(open, /Invalid RequestHub/);
      assert.equal(existsSync(location.lockPath), false);
    });
  }
});

test("Replay refuses repeated completion identities on a multiple-consumption request", async (t) => {
  const { hub, location, open } = await createTestHub(t);
  const request = hub.register(calculation, { input: 1 }, { consumption: "multiple" });
  await hub.complete(calculation, request.requestId, { output: 2 });
  hub.stop();
  const journal = Journal.open(location);
  journal.append(journal.readAll().at(-1)!);
  journal.close();
  assert.throws(open, /Duplicate RequestHub completion/);
  assert.equal(existsSync(location.lockPath), false);
});

test("RequestHub retains request identities across awaited Workflow boundaries and restores results without callbacks", async (t) => {
  const { hub, location, open, scope } = await createTestHub(t);
  let callbacks = 0;
  const request = hub.register(calculation, { input: 1 }, {
    consumption: "multiple", callback: () => { callbacks += 1; },
  });
  await hub.complete(calculation, request.requestId, { output: 2 });
  const previous = readFileSync(location.path, "utf8");
  await scope.workflow.advance("error");

  assert.equal(scope.workflow.snapshot(), undefined);
  assert.equal(existsSync(location.lockPath), false);
  await hub.complete(calculation, request.requestId, { output: 3 });
  assert.equal(readFileSync(location.path, "utf8"), previous, "idle activity cannot mutate historical evidence");
  assert.equal(existsSync(join(scope.runRoot, "request-hub.journal")), false);
  await scope.workflow.startWorkflow();
  assert.equal(scope.workflow.snapshot()?.workflowId, "workflow-002");
  const current = requestHubJournalPaths(scope.workflow.journalRoot);
  const events = readJournalEvents(current.path);
  assert.deepEqual(events.map((event) => event.key.routeKey), [
    RequestHubEvents.requestHub.registered.routeKey,
    RequestHubEvents.requestHub.completed.routeKey,
    RequestHubEvents.requestHub.completed.routeKey,
  ]);
  assert.equal(new Set(events.map((event) => event.id)).size, 3);
  assert.equal(readFileSync(location.path, "utf8"), previous);
  const before = hub.get(calculation, request.requestId);
  hub.stop();
  assert.equal(existsSync(current.lockPath), false);
  const restored = open();
  assert.deepEqual(restored.get(calculation, request.requestId), before);
  assert.equal(callbacks, 2);
  await restored.complete(calculation, request.requestId, { output: 4 });
  assert.equal(callbacks, 2, "restored results and later consumption never resurrect a process-local callback");
  assert.equal(readJournalEvents(current.path).length, 4);
  assert.equal(readFileSync(location.path, "utf8"), previous);
});

test("RequestHub starts in an empty runtime without creating recording files and seeds its first explicit Workflow", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-request-hub-idle-"));
  const runId = "request-hub-idle";
  const runRoot = join(root, "run", runId);
  const manifestStore = new RunManifestStore(runRoot);
  manifestStore.create({ runId, scoutRoot: root, createdAt: new Date().toISOString(), checkpointSeq: 0 });
  const workflow = new Workflow(createTestWorkflowAsset(createDefaultTestGraph().snapshot()));
  const scope = await installTestRunScope(t, { runId, scoutRoot: root, runRoot, workflow, manifestStore });
  await workflow.start();
  const hub = new RequestHub();
  t.after(async () => { hub.stop(); await workflow.stop(); rmSync(root, { recursive: true, force: true }); });
  hub.start();
  scope.workflow.registerParticipant(hub);
  const request = hub.register(calculation, { input: 1 });
  assert.equal(existsSync(join(runRoot, "request-hub.journal")), false);
  assert.equal(existsSync(join(runRoot, "workflows")), false);
  assert.equal(hub.recordObject.hasActiveRecord, false);
  await workflow.startWorkflow();
  const paths = requestHubJournalPaths(scope.workflow.journalRoot);
  assert.equal(existsSync(paths.path), true);
  assert.equal(existsSync(paths.lockPath), true);
  assert.equal(readJournalEvents(paths.path).length, 1);
  assert.deepEqual(hub.get(calculation, request.requestId)?.payload, { input: 1 });
  await hub.complete(calculation, request.requestId, { output: 2 });
  assert.equal(readJournalEvents(paths.path).length, 2);
});

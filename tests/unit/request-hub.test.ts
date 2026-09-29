import assert from "node:assert/strict";
import test from "node:test";
import { RequestHub, type RequestType } from "../../src/core/requeshub/index.js";

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

test("RequestHub keeps unrelated typed requests and rejects a mismatched contract", async () => {
  const hub = new RequestHub();
  const first = hub.register(calculation, { input: 4 });
  const second = hub.register(selection, { choices: ["a", "b"] });
  assert.equal(hub.get(selection, first.requestId), undefined);
  assert.equal(hub.get({ ...calculation }, first.requestId), undefined);
  assert.throws(() => hub.complete(selection, first.requestId, { choice: "a" }), /Unknown/);
  await hub.complete(calculation, first.requestId, { output: 8 });
  await hub.complete(selection, second.requestId, { choice: "b" });
  const completed = hub.get(calculation, first.requestId)!;
  assert.equal(completed.status, "completed");
  if (completed.status !== "completed") throw new Error("Expected completed request.");
  assert.deepEqual(completed.result, { output: 8 });
});

test("RequestHub isolates registration, lookup, result, and callback data", async () => {
  const hub = new RequestHub();
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

test("RequestHub commits before callback and never replays failed callbacks", async () => {
  const hub = new RequestHub();
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
});

test("RequestHub expires pending requests and closes without deleting history", async () => {
  const hub = new RequestHub();
  let callbacks = 0;
  const pending = hub.register(calculation, { input: 1 }, { callback: () => { callbacks += 1; } });
  const completed = hub.register(calculation, { input: 2 });
  await hub.complete(calculation, completed.requestId, { output: 4 });
  assert.equal(hub.expire("missing", "test"), false);
  hub.close();
  hub.close();
  assert.equal(hub.get(calculation, pending.requestId)?.status, "expired");
  assert.equal(hub.get(calculation, completed.requestId)?.status, "completed");
  assert.equal(callbacks, 0);
  assert.throws(() => hub.register(calculation, { input: 3 }), /closed/);
  assert.throws(() => hub.complete(calculation, pending.requestId, { output: 2 }), /closed/);
});

test("RequestHub validates actual data without committing malformed payloads or results", () => {
  const hub = new RequestHub();
  // @ts-expect-error A request contract rejects another payload type at compile time too.
  assert.throws(() => hub.register(calculation, { choices: ["a"] }), /payload/);
  const pending = hub.register(calculation, { input: 1 });
  // @ts-expect-error The result must match the selected contract.
  assert.throws(() => hub.complete(calculation, pending.requestId, { choice: "a" }), /result/);
  assert.equal(hub.get(calculation, pending.requestId)?.status, "pending");
});

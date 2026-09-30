import assert from "node:assert/strict";
import test from "node:test";
import { RequestHubStage } from "../../src/run/lifecycle/stages/request-hub-stage.js";
import { existsSync } from "node:fs";
import type { RequestType } from "../../src/core/requeshub/index.js";
import { RequestHub } from "../../src/core/requeshub/index.js";
import { requestHubJournalPaths } from "../../src/core/path.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("RequestHubStage owns service creation, closure, and replacement while restoring request records", async (t) => {
  const stage = new RequestHubStage();
  t.after(() => stage.stop());
  const scope = installTestRunScope(t, { runId: "request-hub-stage" });
  assert.throws(() => scope.requestHub, /not available/);
  await stage.start();
  const first = scope.requestHub;
  await stage.start();
  assert.equal(scope.requestHub, first);
  assert.throws(() => scope.setRequestHub(first), /already available/);
  const type: RequestType<{ input: number }, { output: number }> = {
    name: "stage", isPayload: (value): value is { input: number } => "input" in value && typeof value.input === "number",
    isResult: (value): value is { output: number } => "output" in value && typeof value.output === "number",
  };
  const request = first.register(type, { input: 1 }, { consumption: "multiple" });
  await first.complete(type, request.requestId, { output: 2 });
  const paths = requestHubJournalPaths(scope.workflow.journalRoot);
  assert.equal(existsSync(paths.path), true);
  assert.equal(existsSync(paths.lockPath), true);
  await stage.stop();
  await stage.stop();
  assert.throws(() => scope.requestHub, /not available/);
  assert.equal(existsSync(paths.lockPath), false);
  await stage.start();
  assert.notEqual(scope.requestHub, first);
  assert.throws(() => scope.clearRequestHub(first), /inactive/);
  assert.deepEqual(scope.requestHub.get(type, request.requestId), first.get(type, request.requestId));
  await scope.requestHub.complete(type, request.requestId, { output: 3 });
});

test("A second RequestHubStage cannot replace or close the installed service", async (t) => {
  const first = new RequestHubStage();
  const second = new RequestHubStage();
  t.after(() => first.stop());
  const scope = installTestRunScope(t, { runId: "request-hub-owner" });
  await first.start();
  const installed = scope.requestHub;
  await assert.rejects(second.start(), /already available/);
  await second.stop();
  assert.equal(scope.requestHub, installed);
});

test("RequestHubStage retains a failed installation for cleanup before retrying", async (t) => {
  const stage = new RequestHubStage();
  t.after(() => stage.stop());
  const scope = installTestRunScope(t, { runId: "request-hub-start-failed" });
  const fault = t.mock.method(RequestHub.prototype, "start", () => { throw new Error("request journal unavailable"); });
  await assert.rejects(stage.start(), /request journal unavailable/);
  const failed = scope.requestHub;
  await assert.rejects(stage.start(), /cleanup is pending/);
  assert.equal(scope.requestHub, failed);
  await stage.stop();
  assert.throws(() => scope.requestHub, /not available/);
  fault.mock.restore();
  await stage.start();
  assert.notEqual(scope.requestHub, failed);
  assert.equal(existsSync(requestHubJournalPaths(scope.workflow.journalRoot).lockPath), true);
});

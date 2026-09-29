import assert from "node:assert/strict";
import test from "node:test";
import { RequestHubStage } from "../../src/run/lifecycle/stages/request-hub-stage.js";
import { RequestHub } from "../../src/core/requeshub/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("RequestHubStage owns service creation, closure, and replacement without reusing old requests", async (t) => {
  const stage = new RequestHubStage();
  t.after(() => stage.stop());
  const scope = installTestRunScope(t, { runId: "request-hub-stage" });
  assert.throws(() => scope.requestHub, /not available/);
  await stage.start();
  const first = scope.requestHub;
  await stage.start();
  assert.equal(scope.requestHub, first);
  assert.throws(() => scope.setRequestHub(first), /already available/);
  assert.throws(() => scope.clearRequestHub(new RequestHub()), /inactive/);
  await stage.stop();
  await stage.stop();
  assert.throws(() => scope.requestHub, /not available/);
  await stage.start();
  assert.notEqual(scope.requestHub, first);
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

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { AuthorizationStage } from "../../src/run/lifecycle/stages/authorization-stage.js";
import { Authorization } from "../../src/core/authorization/authorization.js";
import { AuthorizationRecordObject } from "../../src/core/authorization/record/authorization-record-object.js";
import { RequestHub } from "../../src/core/authorization/request/request-hub.js";
import type { RequestType, ScoutRequest } from "../../src/core/authorization/request/types.js";
import { authorizationJournalPaths } from "../../src/core/path.js";
import { readJournalEvents } from "../../src/core/journal/index.js";
import { WorkflowState } from "../../src/core/workflow/index.js";
import { installTestRunScope } from "../helpers/run-persistence.js";

test("AuthorizationStage installs one public Workflow owner and restores its shared facts", async (t) => {
  const stage = new AuthorizationStage();
  t.after(() => stage.stop());
  const scope = await installTestRunScope(t, { runId: "authorization-stage" });
  assert.throws(() => scope.authorization, /not available/);
  const existingParticipants = scope.workflow.participants;
  await stage.start();
  const authorization = scope.authorization;
  assert.ok(authorization instanceof Authorization);
  assert.deepEqual(scope.workflow.participants, [...existingParticipants, authorization]);
  await stage.start();
  assert.equal(scope.authorization, authorization);
  assert.throws(() => scope.setAuthorization(authorization), /already available/);
  const type: RequestType<ScoutRequest> = { name: "stage", encode: (value) => ({ ...value, state: { status: "active" } }), decode: (value) => structuredClone(value), project: (value) => structuredClone(value) };
  const grant = { scope: { phase: "execute" }, target: { artifactRef: "stage-input" } };
  const request = await authorization.register(type, { maxConsumptions: 2, allowedGrants: [grant] });
  await authorization.submit(request, {
    result: { decision: "approved", ...grant }, consumer: { agentId: "executor" },
  });
  const previousApprovals = authorization.approvals(request);
  assert.equal(authorization.consumed(request), 1);
  const paths = authorizationJournalPaths(scope.workflow.journalRoot);
  assert.equal(existsSync(paths.path), true);
  assert.equal(existsSync(paths.lockPath), true);
  const events = readJournalEvents(paths.path);
  const recovery = {
    workflowData: scope.workflow.snapshot()!, graphData: scope.workflow.graph.snapshot(),
    journalRoot: scope.workflow.journalRoot,
  };
  await stage.stop();
  await stage.stop();
  assert.throws(() => scope.authorization, /not available/);
  assert.deepEqual(scope.workflow.participants, existingParticipants);
  assert.equal(existsSync(paths.lockPath), false);
  assert.deepEqual(readJournalEvents(paths.path), events);
  await scope.workflow.enterState({ state: WorkflowState.Idle });
  await stage.start();
  const restoredOwner = scope.authorization;
  assert.notEqual(restoredOwner, authorization);
  assert.throws(() => scope.clearAuthorization(authorization), /inactive/);
  restoredOwner.registerRequestType(type);
  const read = t.mock.method(AuthorizationRecordObject.prototype, "read");
  await scope.workflow.enterState({ state: WorkflowState.Restoring, input: recovery });
  assert.equal(scope.workflow.state, WorkflowState.Running);
  assert.equal(read.mock.callCount(), 1, "Shared records are decoded once by the Authorization owner.");
  const restored = scope.authorization.get(type, request.requestId)!;
  assert.deepEqual(restored, request);
  assert.deepEqual(scope.authorization.approvals(restored), previousApprovals);
  assert.equal(scope.authorization.consumed(restored), 1);
  assert.deepEqual(readJournalEvents(paths.path), events, "restoration must not create a new approval or replay a grant");
});

test("Authorization abort retains unfinished Workflow requests and credentials for owner recovery", async (t) => {
  const stage = new AuthorizationStage();
  t.after(() => stage.stop());
  const scope = await installTestRunScope(t, { runId: "authorization-abort" });
  await stage.start();
  const type: RequestType<ScoutRequest> = { name: "abort", encode: (value) => ({ ...value, state: { status: "active" } }), decode: (value) => structuredClone(value), project: (value) => structuredClone(value) };
  const grant = { scope: { phase: "execute" }, target: { artifactRef: "unfinished-input" } };
  const request = await scope.authorization.register(type, { maxConsumptions: 1, allowedGrants: [grant] });
  const approved = await scope.authorization.submit(request, {
    result: { decision: "approved", ...grant }, consumer: { agentId: "executor" },
  });
  const credentialId = scope.authorization.credentials(request)[0]!.credentialId;
  const recovery = {
    workflowData: scope.workflow.snapshot()!, graphData: scope.workflow.graph.snapshot(),
    journalRoot: scope.workflow.journalRoot,
  };
  const paths = authorizationJournalPaths(recovery.journalRoot);
  const history = readFileSync(paths.path, "utf8");
  await scope.workflow.enterState({ state: WorkflowState.Aborting });
  assert.equal(scope.workflow.snapshot()?.status, "active");
  assert.equal(scope.authorization.get(type, request.requestId)?.state.status, "active");
  assert.equal(scope.authorization.credential(request, credentialId)?.credentialId, credentialId);
  assert.equal(readFileSync(paths.path, "utf8"), history);
  await stage.stop();
  assert.equal(existsSync(paths.lockPath), false);
  await scope.workflow.enterState({ state: WorkflowState.Idle });
  await stage.start();
  scope.authorization.registerRequestType(type);
  await scope.workflow.enterState({ state: WorkflowState.Restoring, input: recovery });
  const restored = scope.authorization.get(type, request.requestId)!;
  assert.deepEqual(restored, request);
  assert.equal(scope.authorization.consumed(restored), 1);
  assert.equal(readFileSync(paths.path, "utf8"), history, "Recovery does not create an approval.");
  const automatic = await scope.authorization.submit(restored, {
    result: { decision: "approved", ...grant },
    consumer: { agentId: "executor", turnId: "restored-turn" },
  });
  assert.deepEqual(automatic, approved);
  assert.equal(scope.authorization.consumed(restored), 1);
  assert.equal(scope.authorization.credentials(restored).length, 1);
});

test("A second AuthorizationStage cannot replace or close the installed services", async (t) => {
  const first = new AuthorizationStage();
  const second = new AuthorizationStage();
  t.after(() => first.stop());
  const scope = await installTestRunScope(t, { runId: "authorization-owner" });
  await first.start();
  const installed = scope.authorization;
  await assert.rejects(second.start(), /already available/);
  await second.stop();
  assert.equal(scope.authorization, installed);
  assert.equal(existsSync(authorizationJournalPaths(scope.workflow.journalRoot).lockPath), true);
});

test("AuthorizationStage retains failed startup resources for cleanup before retrying", async (t) => {
  const stage = new AuthorizationStage();
  t.after(() => stage.stop());
  const scope = await installTestRunScope(t, { runId: "authorization-start-failed" });
  const fault = t.mock.method(RequestHub.prototype, "start", () => { throw new Error("request projection unavailable"); });
  await assert.rejects(stage.start(), /request projection unavailable/);
  const failed = scope.authorization;
  assert.equal(scope.workflow.participants.includes(failed), false);
  assert.equal(existsSync(authorizationJournalPaths(scope.workflow.journalRoot).lockPath), true);
  await assert.rejects(stage.start(), /cleanup is pending/);
  assert.equal(scope.authorization, failed);
  await stage.stop();
  assert.throws(() => scope.authorization, /not available/);
  assert.equal(existsSync(authorizationJournalPaths(scope.workflow.journalRoot).lockPath), false);
  fault.mock.restore();
  await stage.start();
  assert.notEqual(scope.authorization, failed);
  assert.equal(existsSync(authorizationJournalPaths(scope.workflow.journalRoot).lockPath), true);
});

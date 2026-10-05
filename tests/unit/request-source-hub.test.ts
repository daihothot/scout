import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import test, { type TestContext } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Authorization, ApprovalCenter, ApprovalEvents, CredentialEvents, RequestSourceEvents, RequestSourceHub,
  type RequestSourceRegisteredEvent, type RequestSourceType, type ScoutRequestSource } from "../../src/core/authorization/index.js";
import type { ScoutRequestSourceRecord, RequestSourceRegisteredRecord } from "../../src/core/authorization/record/authorization-record.js";
import type { ApprovalSubmittedEvent } from "../../src/core/authorization/approval/approval-events.js";
import { Journal, readJournalEvents } from "../../src/core/journal/index.js";
import { authorizationJournalPaths } from "../../src/core/io/index.js";
import { Workflow } from "../../src/core/workflow/index.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import { createDefaultTestGraph, installTestRunScope, createTestWorkflowAsset } from "../helpers/run-persistence.js";

interface ArtifactRequest extends ScoutRequestSource { readonly type: "test.artifact"; readonly purpose: string }
interface ArtifactRecord extends ScoutRequestSourceRecord { readonly type: "test.artifact"; readonly purpose: string }
interface ExecutionRequest extends ScoutRequestSource { readonly type: "test.execution"; readonly task: number }
interface ExecutionRecord extends ScoutRequestSourceRecord { readonly type: "test.execution"; readonly task: number }
const artifact: RequestSourceType<ArtifactRequest, ArtifactRecord> = {
  name: "test.artifact",
  encode(value) { return { ...value, state: { status: "active" } }; },
  decode(value) {
    if (!("purpose" in value) || typeof value.purpose !== "string") throw new Error("Invalid stored artifact purpose.");
    return { ...value, type: "test.artifact", purpose: value.purpose };
  },
  project(value) { return structuredClone(value); },
  decodeGrant(value) { return structuredClone(value); },
  match(source, request) { return source.allowedGrants.find((grant) => isDeepStrictEqual(grant.scope, request.scope) && isDeepStrictEqual(grant.target, request.target)); },
  covers(source, grant) { return source.allowedGrants.some((allowed) => isDeepStrictEqual(allowed.scope, grant.scope) && isDeepStrictEqual(allowed.target, grant.target)); },
};
const execution: RequestSourceType<ExecutionRequest, ExecutionRecord> = {
  name: "test.execution",
  encode(value) { return { ...value, state: { status: "active" } }; },
  decode(value) {
    if (!("task" in value) || typeof value.task !== "number") throw new Error("Invalid stored execution task.");
    return { ...value, type: "test.execution", task: value.task };
  },
  project(value) { return structuredClone(value); },
  decodeGrant(value) { return structuredClone(value); },
  match(source, request) { return source.allowedGrants.find((grant) => isDeepStrictEqual(grant.scope, request.scope) && isDeepStrictEqual(grant.target, request.target)); },
  covers(source, grant) { return source.allowedGrants.some((allowed) => isDeepStrictEqual(allowed.scope, grant.scope) && isDeepStrictEqual(allowed.target, grant.target)); },
};
const executorGrant = { scope: { agentId: "executor", access: "read" }, target: { path: "pack-a/execute-file.json" } };
const reviewerGrant = { scope: { agentId: "reviewer", access: "read" }, target: { path: "pack-b/execute-file.json" } };
const input = (sourceKey = "artifact-default") => ({ sourceKey, purpose: "Inspect execution artifact", maxApprovals: 2, allowedGrants: structuredClone([executorGrant, reviewerGrant]) });
const approved = (grant = executorGrant) => ({
  ...structuredClone(grant),
  consumer: { agentId: grant.scope.agentId, threadId: "thread-1", turnId: "turn-1" },
});

async function createTestAuthorization(t: TestContext, contracts: readonly RequestSourceType<ScoutRequestSource>[] = [artifact, execution]) {
  const root = mkdtempSync(join(tmpdir(), "scout-authorization-test-"));
  const scope = await installTestRunScope(t, { runId: "authorization", scoutRoot: root, runRoot: join(root, "run", "authorization") });
  const location = { journalId: `${scope.runId}:authorization`, ...authorizationJournalPaths(scope.workflow.journalRoot) };
  const instances: Array<{ close(): void }> = [];
  function open(types = contracts) {
    const authorization = new Authorization();
    let installed = false;
    const close = () => {
      authorization.stop();
      if (installed) { scope.workflow.unregisterParticipant(authorization); installed = false; }
    };
    try {
      for (const type of types) authorization.registerRequestSourceType(type);
      authorization.start(); authorization.restore(scope.workflow.snapshot()!);
    } catch (error) { close(); throw error; }
    scope.workflow.registerParticipant(authorization);
    installed = true;
    const instance = { authorization, close };
    instances.push(instance);
    return instance;
  }
  t.after(() => {
    for (const instance of instances) instance.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { ...open(), location, open, scope };
}

test("RequestSourceHub keeps concrete request contracts separate and only parses restored data", async (t) => {
  const decode = t.mock.fn(artifact.decode);
  const contract = { ...artifact, decode };
  const { authorization: auth, close, open } = await createTestAuthorization(t, [contract, execution]);
  const first = await auth.register(contract, input());
  const second = await auth.register(execution, { sourceKey: "execution", maxApprovals: 1, allowedGrants: [executorGrant], task: 4 });
  assert.equal(auth.get(execution, first.sourceId), undefined);
  assert.equal(auth.get({ ...contract }, first.sourceId), undefined);
  await assert.rejects(auth.register({ ...contract }, input()), /contract|bound/i);
  assert.equal(auth.get(contract, first.sourceId)?.purpose, input().purpose);
  assert.equal(auth.get(execution, second.sourceId)?.task, 4);
  assert.equal(decode.mock.callCount(), 0, "Live typed registration does not decode its own data.");
  close();
  const restored = open().authorization;
  assert.equal(decode.mock.callCount(), 1, "Concrete decoding finishes during restore, not on first lookup.");
  assert.deepEqual(restored.get(contract, first.sourceId), first);
  assert.deepEqual(restored.get(contract, first.sourceId), first);
  assert.equal(decode.mock.callCount(), 1);
});

test("Registration and public snapshots cannot mutate request constraints", async (t) => {
  const { authorization: auth } = await createTestAuthorization(t);
  const registration = input();
  const request = await auth.register(artifact, registration);
  registration.allowedGrants[0]!.target.path = "outside.json";
  Object.assign(request.allowedGrants[0]!.scope, { agentId: "outside" });
  Object.assign(request, { maxApprovals: 99 });
  const stored = auth.get(artifact, request.sourceId)!;
  assert.deepEqual(stored.allowedGrants, [executorGrant, reviewerGrant]);
  assert.equal(stored.maxApprovals, 2);
  Object.assign(stored.allowedGrants[0]!.target, { path: "changed.json" });
  assert.deepEqual(auth.get(artifact, request.sourceId)?.allowedGrants, [executorGrant, reviewerGrant]);
});

test("An immediate registration subscriber can expire a committed request without state being overwritten", async (t) => {
  const { authorization: auth, scope, location } = await createTestAuthorization(t);
  let expiration: Promise<boolean> | undefined;
  scope.eventBus.subscribe<RequestSourceRegisteredEvent>(RequestSourceEvents.authorizationRequestSource.registered, ({ payload }) => {
    assert.equal(auth.get(artifact, payload.source.sourceId)?.state.status, "active");
    expiration = auth.expire(payload.source.sourceId, "consumer_cancelled");
    Object.assign(payload.source, { maxApprovals: 99 });
  });
  const request = await auth.register(artifact, input());
  await scope.eventBus.drain(RequestSourceEvents.authorizationRequestSource.registered);
  assert.equal(await expiration, true);
  assert.equal(auth.get(artifact, request.sourceId)?.state.status, "expired");
  assert.equal(auth.get(artifact, request.sourceId)?.maxApprovals, 2);
  assert.deepEqual(readJournalEvents(location.path).map(({ key }) => key.routeKey), [
    RequestSourceEvents.authorizationRequestSource.registered.routeKey, RequestSourceEvents.authorizationRequestSource.expired.routeKey,
  ]);
});

test("New approvals consume a finite quota while denial and credential reuse do not", async (t) => {
  const { authorization: auth, location } = await createTestAuthorization(t);
  const request = await auth.register(artifact, input());
  assert.equal((await auth.submit(artifact, { workflowId: request.workflowId, scope: {}, target: {}, consumer: {} })).decision, "denied");
  assert.equal(auth.consumed(request), 0);
  assert.deepEqual(auth.credentials(request), []);
  const firstResult = await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  const first = auth.approvals(request)[0]!;
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved(reviewerGrant) });
  assert.equal(auth.consumed(request), 2);
  assert.equal(auth.credentials(request).length, 2);
  assert.notEqual(first.approvalId, auth.approvals(request)[1]!.approvalId);
  const reused = await auth.submit(artifact, { workflowId: request.workflowId, ...{ ...approved(), consumer: { agentId: "executor", turnId: "turn-2" } } });
  assert.deepEqual(reused, firstResult);
  assert.equal(auth.consumed(request), 2);
  assert.equal(auth.approvals(request).length, 2, "ApprovalCenter only stores matched new decisions.");
  assert.equal(auth.credentialUses(first.approvalId).length, 1);
  assert.equal(auth.get(artifact, request.sourceId)?.state.status, "active");
  assert.equal(readJournalEvents(location.path).length, 4, "New approval and credential use are each recorded once.");
  const limited = await auth.register(artifact, { ...input("limited"), maxApprovals: 1 });
  await auth.expire(request.sourceId, "replace_source");
  // Existing matching rights can still be used without spending this new request's allowance.
  assert.deepEqual(await auth.submit(artifact, { workflowId: limited.workflowId, ...approved() }), firstResult);
  assert.equal(auth.consumed(limited), 0);
});

test("Credential grants serve matching same-type requests while preserving issuance identity across restore", async (t) => {
  const { authorization: auth, close, open } = await createTestAuthorization(t);
  const source = await auth.register(artifact, input());
  const other = await auth.register(artifact, input("other"));
  const differentType = await auth.register(execution, { sourceKey: "execution", task: 1, maxApprovals: 1, allowedGrants: [executorGrant] });
  const differentBounds = await auth.register(artifact, { ...input("different-bounds"), allowedGrants: [reviewerGrant] });
  const first = await auth.submit(artifact, { workflowId: source.workflowId, ...approved() });
  const credential = auth.credentials(source)[0]!;
  await auth.expire(source.sourceId, "replace_source");
  const reused = await auth.submit(artifact, { workflowId: other.workflowId, ...approved() });
  assert.deepEqual(reused, first);
  assert.equal(auth.consumed(source), 1);
  assert.equal(auth.consumed(other), 0);
  assert.equal(auth.credentials(other)[0]!.sourceId, source.sourceId);
  assert.deepEqual(auth.credentials(differentType), []);
  const outsideBounds = { scope: { agentId: "outside" }, target: { path: "outside.json" }, consumer: {} };
  assert.equal((await auth.submit(artifact, { workflowId: differentBounds.workflowId, ...outsideBounds })).decision, "denied");
  const uses = auth.credentialUses(credential.credentialId);
  assert.equal(uses[0]!.sourceId, other.sourceId);
  close();
  const restored = open().authorization;
  const resumed = restored.get(artifact, other.sourceId)!;
  assert.deepEqual(restored.credential(resumed, credential.credentialId), credential);
  assert.deepEqual(restored.credentialUses(credential.credentialId), uses);
  assert.equal(restored.consumed(resumed), 0);
  assert.equal(restored.consumed(restored.get(artifact, source.sourceId)!), 1);
});

test("Submission uses registered constraints rather than a caller-modified request snapshot", async (t) => {
  const { authorization: auth } = await createTestAuthorization(t);
  const request = await auth.register(artifact, { ...input(), maxApprovals: 1 });
  Object.assign(request, { maxApprovals: 99 });
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  assert.equal((await auth.submit(artifact, { workflowId: request.workflowId, ...approved(reviewerGrant) })).decision, "denied");
  assert.equal(auth.consumed(request), 1);
  assert.equal(auth.get(artifact, request.sourceId)?.maxApprovals, 1);
});

test("New approval cannot expand registered grants through a modified request handle", async (t) => {
  const { authorization: auth, location, close, open } = await createTestAuthorization(t);
  const request = await auth.register(artifact, input());
  const unregistered = { scope: { agentId: "other", access: "write" }, target: { path: "outside.json" } };
  const before = readFileSync(location.path, "utf8");
  Object.assign(request, { allowedGrants: [unregistered] });
  assert.equal((await auth.submit(artifact, { workflowId: request.workflowId, ...approved(unregistered) })).decision, "denied");
  assert.deepEqual(auth.approvals(request), []);
  assert.deepEqual(auth.credentials(request), []);
  assert.equal(auth.consumed(request), 0);
  assert.equal(readFileSync(location.path, "utf8"), before);
  const accepted = await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  close();
  const restored = open().authorization;
  const resumed = restored.get(artifact, request.sourceId)!;
  assert.deepEqual(resumed.allowedGrants, [executorGrant, reviewerGrant]);
  assert.deepEqual(restored.approvals(resumed)[0]!.result, accepted);
  assert.deepEqual(restored.credentials(resumed)[0]!.target, executorGrant.target);
});

test("Committed approval and credential data are isolated from callers and event subscribers", async (t) => {
  const { authorization: auth, scope, location } = await createTestAuthorization(t);
  const request = await auth.register(artifact, input());
  let observed: { consumed: number; hasCredential: boolean } | undefined;
  scope.eventBus.subscribe<ApprovalSubmittedEvent>(ApprovalEvents.authorizationApproval.submitted, ({ payload }) => {
    observed = { consumed: auth.consumed(request), hasCredential: auth.credential(request, payload.approvalId) !== undefined };
    if (payload.result.decision === "approved") Object.assign(payload.result.target, { path: "event-mutation.json" });
    Object.assign(payload.consumer, { agentId: "event-mutation" });
  });
  scope.eventBus.subscribe(CredentialEvents.authorizationCredential.issued, () => { throw new Error("observer failure"); });
  const submission = approved();
  const result = await auth.submit(artifact, { workflowId: request.workflowId, ...submission });
  submission.target.path = "caller-mutation.json";
  submission.consumer.agentId = "caller-mutation";
  if (result.decision === "approved") Object.assign(result.scope, { agentId: "snapshot-mutation" });
  await scope.eventBus.drain(ApprovalEvents.authorizationApproval.submitted);
  await scope.eventBus.drain(CredentialEvents.authorizationCredential.issued);
  assert.deepEqual(observed, { consumed: 1, hasCredential: true });
  const original = auth.approvals(request)[0]!;
  assert.deepEqual(original.result, { decision: "approved", ...executorGrant });
  const credential = auth.credential(request, original.approvalId)!;
  Object.assign(credential.target, { path: "credential-mutation.json" });
  assert.deepEqual(auth.credential(request, original.approvalId)?.target, executorGrant.target);
  assert.deepEqual(readJournalEvents(location.path).at(-1)!.payload, original);
});

test("Closing preserves requests and restoration rebuilds approvals and credentials without republishing", async (t) => {
  const { authorization: auth, close, open, location, scope } = await createTestAuthorization(t);
  const request = await auth.register(artifact, { ...input(), maxApprovals: 1 });
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  const credential = auth.credentials(request)[0]!;
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  const before = readFileSync(location.path, "utf8");
  const approvals = auth.approvals(request), credentials = auth.credentials(request), uses = auth.credentialUses(credential.credentialId);
  close(); close();
  assert.equal(existsSync(location.lockPath), false);
  let notifications = 0;
  const subscriptions = [
    scope.eventBus.subscribe(ApprovalEvents.authorizationApproval.submitted, () => { notifications += 1; }),
    scope.eventBus.subscribe(CredentialEvents.authorizationCredential.issued, () => { notifications += 1; }),
    scope.eventBus.subscribe(CredentialEvents.authorizationCredential.used, () => { notifications += 1; }),
  ];
  const restored = open().authorization;
  const resumed = restored.get(artifact, request.sourceId)!;
  assert.deepEqual(resumed, request);
  assert.deepEqual(restored.approvals(resumed), approvals);
  assert.deepEqual(restored.credentials(resumed), credentials);
  assert.deepEqual(restored.credentialUses(credential.credentialId), uses);
  assert.equal(notifications, 0);
  assert.equal(readFileSync(location.path, "utf8"), before);
  for (const unsubscribe of subscriptions) unsubscribe();
  await restored.submit(artifact, { workflowId: resumed.workflowId, ...approved() });
  assert.equal(restored.consumed(resumed), 1);
  assert.equal(restored.credentialUses(credential.credentialId).length, 2);
});

test("Explicit expiry is restored and rejects new approval and existing credential use", async (t) => {
  const { authorization: auth, close, open } = await createTestAuthorization(t);
  const request = await auth.register(artifact, input());
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  assert.equal(await auth.expire(request.sourceId, "consumer_cancelled"), true);
  assert.equal(await auth.expire(request.sourceId, "again"), false);
  assert.equal(await auth.expire("missing", "test"), false);
  assert.equal((await auth.submit(artifact, { workflowId: request.workflowId, ...approved() })).decision, "denied");
  close();
  const restored = open().authorization;
  const expired = restored.get(artifact, request.sourceId)!;
  assert.equal(expired.state.status, "expired");
  if (expired.state.status !== "expired") assert.fail();
  assert.equal(expired.state.reason, "consumer_cancelled");
  assert.equal((await restored.submit(artifact, { workflowId: expired.workflowId, ...approved() })).decision, "denied");
  assert.equal(restored.approvals(expired).length, 1);
});

test("Append failure leaves registration, approval, credential issuance, and expiry uncommitted", async (t) => {
  const { authorization: auth, location, scope } = await createTestAuthorization(t);
  const request = await auth.register(artifact, input());
  const original = auth.get(artifact, request.sourceId);
  const events = readJournalEvents(location.path);
  let notifications = 0;
  scope.eventBus.subscribe(ApprovalEvents.authorizationApproval.submitted, () => { notifications += 1; });
  scope.eventBus.subscribe(CredentialEvents.authorizationCredential.issued, () => { notifications += 1; });
  const fault = t.mock.method(Journal.prototype, "append", () => { throw new Error("disk unavailable"); });
  await assert.rejects(auth.register(artifact, input("second")), /disk unavailable/);
  await assert.rejects(auth.submit(artifact, { workflowId: request.workflowId, ...approved() }), /disk unavailable/);
  await assert.rejects(auth.expire(request.sourceId, "cancel"), /disk unavailable/);
  assert.deepEqual(auth.get(artifact, request.sourceId), original);
  assert.deepEqual(auth.approvals(request), []);
  assert.deepEqual(auth.credentials(request), []);
  assert.equal(auth.consumed(request), 0);
  assert.equal(notifications, 0);
  assert.deepEqual(readJournalEvents(location.path), events);
  fault.mock.restore();
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  const credential = auth.credentials(request)[0]!;
  const usesBefore = readJournalEvents(location.path);
  const useFault = t.mock.method(Journal.prototype, "append", () => { throw new Error("use write failed"); });
  await assert.rejects(auth.submit(artifact, { workflowId: request.workflowId, ...approved() }), /use write failed/);
  assert.deepEqual(auth.credentialUses(credential.credentialId), []);
  assert.equal(auth.consumed(request), 1);
  assert.deepEqual(readJournalEvents(location.path), usesBefore);
  useFault.mock.restore();
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  assert.equal(auth.credentialUses(credential.credentialId).length, 1);
});

test("Restored concrete request parsing fails before aggregation without exposing partial runtime data", async (t) => {
  const { authorization: auth, close, open } = await createTestAuthorization(t);
  await auth.register(artifact, input());
  close();
  const wrong = { ...artifact, decode() { throw new Error("Invalid stored purpose"); } };
  assert.throws(() => open([wrong, execution]), /Invalid stored purpose/);
  assert.doesNotThrow(open);
});

test("Extra persisted payload fields cannot change authorization facts during recovery", async (t) => {
  const { authorization: auth, close, open, location } = await createTestAuthorization(t);
  const request = await auth.register(artifact, input());
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  await auth.expire(request.sourceId, "finished");
  const expectedRequest = auth.get(artifact, request.sourceId);
  const expectedApprovals = auth.approvals(request);
  const expectedCredentials = auth.credentials(request);
  const credentialId = expectedCredentials[0]!.credentialId;
  const expectedUses = auth.credentialUses(credentialId);
  close();

  const journal = Journal.open(location);
  const facts = journal.readAll();
  Object.assign(facts[0]!.payload as object, { consumer: {}, result: { decision: "denied" } });
  Object.assign(facts[1]!.payload as object, {
    request: { ...artifact.encode(request), sourceId: "unexpected-request" },
  });
  Object.assign(facts[2]!.payload as object, { result: { decision: "denied" } });
  Object.assign(facts[3]!.payload as object, { consumer: {}, result: { decision: "approved" } });
  journal.replaceAll(facts);
  journal.close();

  const restored = open().authorization;
  assert.deepEqual(restored.get(artifact, request.sourceId), expectedRequest);
  assert.equal(restored.find("unexpected-request"), undefined);
  assert.deepEqual(restored.approvals(request), expectedApprovals);
  assert.equal(restored.consumed(request), 1);
  assert.deepEqual(restored.credentials(request), expectedCredentials);
  assert.deepEqual(restored.credentialUses(credentialId), expectedUses);
});

test("Authorization refuses duplicate and invalid replay transitions and cleanup releases the journal", async (t) => {
  for (const corruption of ["duplicate_registration", "duplicate_approval", "unknown_request", "after_expiry", "unknown_event", "quota_exceeded"]) {
    await t.test(corruption, async (t) => {
      const { authorization: auth, close, open, location } = await createTestAuthorization(t);
      const request = await auth.register(artifact, { ...input(), maxApprovals: 1 });
      await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
      const first = auth.approvals(request)[0]!;
      if (corruption === "after_expiry") await auth.expire(request.sourceId, "cancelled");
      close();
      const journal = Journal.open(location);
      const events = journal.readAll();
      const event = structuredClone(corruption === "duplicate_registration" ? events[0]! : events[1]!);
      if (corruption !== "duplicate_approval") {
        event.id = `${first.approvalId}-${corruption}`;
        if (corruption !== "duplicate_registration") Object.assign(event.payload as object, { approvalId: event.id });
      }
      if (corruption === "unknown_request") Object.assign(event.payload as object, { sourceId: "missing" });
      if (corruption === "unknown_event") event.key = { ...event.key, routeKey: "system.authorization.unknown" };
      journal.append(event); journal.close();
      assert.throws(open, /duplicate|registered|unknown|active|expired|quota|invalid/i);
      assert.equal(existsSync(location.lockPath), false);
    });
  }
});

test("Authorization validates malformed persisted requests, decisions, and expiry at the restore boundary", async (t) => {
  for (const corruption of ["quota", "grants", "purpose", "unknown_type", "decision", "basis", "grant", "expiry"]) {
    await t.test(corruption, async (t) => {
      const { authorization: auth, close, location, open } = await createTestAuthorization(t);
      const request = await auth.register(artifact, input());
      await auth.submit(artifact, { workflowId: request.workflowId, ...approved() }); await auth.expire(request.sourceId, "cancelled"); close();
      const journal = Journal.open(location), facts = journal.readAll();
      const payload = facts[0]!.payload as RequestSourceRegisteredRecord;
      if (corruption === "quota") Object.assign(payload.source, { maxApprovals: "unlimited" });
      else if (corruption === "grants") Object.assign(payload.source, { allowedGrants: null });
      else if (corruption === "purpose") Object.assign(payload.source, { purpose: false });
      else if (corruption === "unknown_type") Object.assign(payload.source, { type: "missing" });
      else if (corruption === "decision") Object.assign(facts[1]!.payload as object, { result: null });
      else if (corruption === "basis") Object.assign(facts[1]!.payload as object, { basis: { kind: "unknown" } });
      else if (corruption === "grant") Object.assign(facts[1]!.payload as object, { result: { decision: "approved", scope: executorGrant.scope, target: { path: "unregistered.json" } } });
      else Object.assign(facts[2]!.payload as object, { reason: "" });
      journal.replaceAll(facts); journal.close();
      assert.throws(open, /invalid|malformed|unknown/i);
      assert.equal(existsSync(location.lockPath), false);
    });
  }
});

test("Restored credential use requires an earlier matching issuance fact", async (t) => {
  for (const corruption of ["missing_credential", "use_before_issuance", "wrong_type", "wrong_bounds", "after_expiry", "wrong_workflow"]) {
    await t.test(corruption, async (t) => {
      const { authorization: auth, close, location, open } = await createTestAuthorization(t);
      const request = await auth.register(artifact, input());
      await auth.submit(artifact, { workflowId: request.workflowId, ...approved() }); await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
      if (corruption === "after_expiry") await auth.expire(request.sourceId, "cancelled");
      close();
      const journal = Journal.open(location), facts = journal.readAll();
      if (corruption === "missing_credential") Object.assign(facts[2]!.payload as object, { credentialId: "missing" });
      else if (corruption === "use_before_issuance") [facts[1], facts[2]] = [facts[2]!, facts[1]!];
      else if (corruption === "wrong_workflow") Object.assign(facts[2]!.payload as object, { workflowId: "other" });
      else if (corruption === "after_expiry") [facts[2], facts[3]] = [facts[3]!, facts[2]!];
      else {
        const another: ScoutRequestSourceRecord = { ...artifact.encode(request), sourceId: "consumer", sourceKey: "consumer-key",
          type: corruption === "wrong_type" ? "test.execution" : "test.artifact",
          allowedGrants: corruption === "wrong_bounds" ? [reviewerGrant] : request.allowedGrants };
        facts.splice(2, 0, { ...structuredClone(facts[0]!), id: "another-registration", payload: { source: { ...another, task: 1 } } });
        Object.assign(facts[3]!.payload as object, { sourceId: "consumer" });
      }
      journal.replaceAll(facts); journal.close();
      assert.throws(open, /credential/i);
      assert.equal(existsSync(location.lockPath), false);
    });
  }
});

test("Authorization requires startup and closed services refuse mutations", async (t) => {
  const { authorization: auth, close, open } = await createTestAuthorization(t);
  assert.throws(open, /already attached/i);
  auth.start();
  const request = await auth.register(artifact, input());
  const unstarted = new Authorization();
  await assert.rejects(unstarted.register(artifact, input()), /not started/i);
  await assert.rejects(unstarted.submit(artifact, { workflowId: request.workflowId, ...approved() }), /not started/i);
  unstarted.stop();
  assert.throws(() => unstarted.start(), /closed/i);
  const hub = new RequestSourceHub(new Map());
  assert.throws(() => hub.register(artifact, input(), request.workflowId), /not started/i);
  const center = new ApprovalCenter();
  assert.throws(() => center.submit(request, { consumer: {}, result: { decision: "approved", ...executorGrant } }), /not started/i);
  hub.stop(); center.stop();
  assert.throws(() => hub.start(), /closed/i); assert.throws(() => center.start(), /closed/i);
  close();
  await assert.rejects(auth.register(artifact, input()), /closed/i);
  await assert.rejects(auth.submit(artifact, { workflowId: request.workflowId, ...approved() }), /closed/i);
  await assert.rejects(auth.expire(request.sourceId, "after_close"), /closed/i);
});

test("Workflow completion ends authorization use and a new Workflow does not copy historical requests", async (t) => {
  const { authorization: auth, location, open, close, scope } = await createTestAuthorization(t);
  const request = await auth.register(artifact, input());
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  const credential = auth.credentials(request)[0]!;
  await scope.workflow.advance("error");
  assert.equal(scope.workflow.snapshot(), undefined);
  assert.equal(existsSync(location.lockPath), false);
  const historical = readFileSync(location.path, "utf8");
  await assert.rejects(auth.register(artifact, input()), /active.*workflow|workflow.*active/i);
  await assert.rejects(auth.submit(artifact, { workflowId: request.workflowId, ...approved() }), /active.*workflow|workflow.*active|expired/i);
  assert.equal(existsSync(join(scope.runRoot, "authorization.journal")), false);
  await scope.workflow.startWorkflow("test");
  assert.equal(scope.workflow.snapshot()?.workflowId, "workflow-002");
  assert.deepEqual(readJournalEvents(authorizationJournalPaths(scope.workflow.journalRoot).path), []);
  assert.equal(auth.get(artifact, request.sourceId), undefined);
  assert.deepEqual(auth.approvals(request), []); assert.deepEqual(auth.credentials(request), []);
  await assert.rejects(auth.submit(artifact, { workflowId: request.workflowId, ...approved() }), /active Workflow/);
  const next = await auth.register(artifact, input());
  assert.equal(next.workflowId, "workflow-002");
  assert.notEqual(next.sourceId, request.sourceId);
  assert.equal(auth.credential(next, credential.credentialId), undefined);
  await auth.submit(artifact, { workflowId: next.workflowId, ...approved() });
  assert.equal(auth.consumed(next), 1);
  assert.equal(readFileSync(location.path, "utf8"), historical);
  close();
  const restored = open().authorization;
  assert.equal(restored.get(artifact, request.sourceId), undefined);
  assert.deepEqual(restored.get(artifact, next.sourceId), next);
  assert.equal(restored.consumed(next), 1); assert.equal(restored.credentials(next).length, 1);
});

test("Authorization starts in an empty runtime but registration waits for an explicitly started Workflow", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-authorization-idle-"));
  const runId = "authorization-idle", runRoot = join(root, "run", runId);
  const manifestStore = new RunManifestStore(runRoot);
  manifestStore.create({ runId, scoutRoot: root, createdAt: new Date().toISOString(), checkpointSeq: 0 });
  const workflow = new Workflow(createTestWorkflowAsset(createDefaultTestGraph().snapshot()));
  const scope = await installTestRunScope(t, { runId, scoutRoot: root, runRoot, workflow, manifestStore });
  await workflow.start();
  const auth = new Authorization();
  t.after(async () => { auth.stop(); workflow.unregisterParticipant(auth); await workflow.stop(); rmSync(root, { recursive: true, force: true }); });
  auth.start(); workflow.registerParticipant(auth);
  await assert.rejects(auth.register(artifact, input()), /active.*workflow|workflow.*active/i);
  assert.equal(existsSync(join(runRoot, "authorization.journal")), false);
  assert.equal(existsSync(join(runRoot, "workflows")), false);
  await workflow.startWorkflow("test");
  const paths = authorizationJournalPaths(scope.workflow.journalRoot);
  assert.deepEqual(readJournalEvents(paths.path), []);
  const request = await auth.register(artifact, input());
  await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
  assert.equal(readJournalEvents(paths.path).length, 2);
});

test("Concurrent approval candidates cannot exceed quota, and matching candidates reuse the committed credential", async (t) => {
  const { authorization: auth } = await createTestAuthorization(t);
  const request = await auth.register(artifact, { ...input(), maxApprovals: 1 });
  const results = await Promise.all([auth.submit(artifact, { workflowId: request.workflowId, ...approved() }), auth.submit(artifact, { workflowId: request.workflowId, ...approved() }), auth.submit(artifact, { workflowId: request.workflowId, ...approved(reviewerGrant) })]);
  assert.deepEqual(results.map((result) => result.decision), ["approved", "approved", "denied"]);
  assert.equal(auth.consumed(request), 1);
  assert.equal(auth.credentials(request).length, 1);
  assert.equal(auth.credentialUses(auth.credentials(request)[0]!.credentialId).length, 1);
});

test("A stalled or failed observational subscriber cannot block a committed authorization result", async (t) => {
  const { authorization: auth, scope } = await createTestAuthorization(t);
  const request = await auth.register(artifact, input());
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  scope.eventBus.subscribe(ApprovalEvents.authorizationApproval.submitted, () => stalled);
  try {
    const result = await auth.submit(artifact, { workflowId: request.workflowId, ...approved() });
    assert.equal(result.decision, "approved");
    assert.equal(auth.consumed(request), 1);
    assert.equal(auth.credentials(request).length, 1);
  } finally { release(); }
  await scope.eventBus.drain(ApprovalEvents.authorizationApproval.submitted);
});

test("Source identity is idempotent across concurrent registration and restore, without replacing provenance or refilling quota", async (t) => {
  const { authorization: auth, close, open, location } = await createTestAuthorization(t);
  const registration = { ...input(), maxApprovals: 1 };
  const [first, second] = await Promise.all([
    auth.register(artifact, registration), auth.register(artifact, { ...registration, purpose: "Different lookup caller" }),
  ]);
  assert.deepEqual(second, first);
  assert.equal(readJournalEvents(location.path).length, 1);
  await auth.submit(artifact, { workflowId: first.workflowId, ...approved() });
  assert.equal(auth.consumed(first), 1);
  assert.deepEqual(await auth.register(artifact, registration), first);
  await assert.rejects(auth.register(artifact, { ...registration, maxApprovals: 2 }), /registration conflict/);
  await assert.rejects(auth.register(artifact, { ...registration, allowedGrants: [executorGrant] }), /registration conflict/);
  close();
  const restored = open().authorization;
  assert.deepEqual(await restored.register(artifact, registration), first);
  assert.equal(restored.consumed(first), 1);
  assert.equal((await restored.submit(artifact, { workflowId: first.workflowId, ...approved(reviewerGrant) })).decision, "denied");
  await restored.expire(first.sourceId, "cancelled");
  const expired = await restored.register(artifact, registration);
  assert.equal(expired.sourceId, first.sourceId);
  assert.equal(expired.state.status, "expired");
  assert.equal((await restored.submit(artifact, { workflowId: first.workflowId, ...approved() })).decision, "denied");
});

test("Matching keeps independent candidates and selects the earliest available source, before and after restore", async (t) => {
  const { authorization: auth, close, open } = await createTestAuthorization(t);
  const first = await auth.register(artifact, { ...input("first"), maxApprovals: 1 });
  const second = await auth.register(artifact, { ...input("second"), maxApprovals: 1 });
  assert.notEqual(first.sourceId, second.sourceId);
  assert.equal((await auth.submit(artifact, { workflowId: first.workflowId, ...approved() })).decision, "approved");
  assert.equal(auth.consumed(first), 1);
  assert.equal(auth.consumed(second), 0);
  close();
  const restored = open().authorization;
  assert.deepEqual(restored.sources(artifact).map(({ sourceId }) => sourceId), [first.sourceId, second.sourceId]);
  assert.equal((await restored.submit(artifact, { workflowId: first.workflowId, ...approved(reviewerGrant) })).decision, "approved");
  assert.equal(restored.consumed(first), 1);
  assert.equal(restored.consumed(second), 1);
  assert.equal(restored.approvals(second)[0]!.result.decision, "approved");
  assert.equal((await restored.submit(artifact, { workflowId: first.workflowId, ...approved() })).decision, "approved");
  assert.equal(restored.consumed(first), 1);
  assert.equal(restored.consumed(second), 1);
});

test("A failed selected-source write never retries another matching source or spends either allowance", async (t) => {
  const { authorization: auth } = await createTestAuthorization(t);
  const first = await auth.register(artifact, input("first"));
  const second = await auth.register(artifact, input("second"));
  const attemptedSources: string[] = [];
  t.mock.method(Journal.prototype, "append", (event: { payload: { sourceId: string } }) => {
    attemptedSources.push(event.payload.sourceId);
    throw new Error("selected write failed");
  });
  await assert.rejects(auth.submit(artifact, { workflowId: first.workflowId, ...approved() }), /selected write failed/);
  assert.ok(attemptedSources.length > 0);
  assert.deepEqual([...new Set(attemptedSources)], [first.sourceId], "Record-layer retries do not select another source.");
  assert.equal(auth.consumed(first), 0);
  assert.equal(auth.consumed(second), 0);
  assert.deepEqual(auth.credentials(first), []);
});

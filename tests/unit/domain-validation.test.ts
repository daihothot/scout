import test from "node:test";
import assert from "node:assert/strict";
import {
  buildValidationStateSnapshot,
  validateDomainValidationArtifact,
  type ArtifactRef,
  type EvidenceRef,
  type SourceRef,
  type UserInputObservation,
  type WorkerOutcomeObservation,
} from "../../src/domain/index.js";

test("domain validation artifact validator accepts a complete ResearchArtifact", () => {
  const artifact = {
    artifact_type: "ResearchArtifact",
    artifact_version: 1,
    artifact_id: "research-1",
    run_id: "run-1",
    task_id: "task-research",
    status: "complete",
    input_summary: "用户提供了一个 BDD。",
    bdd_facts: {
      scenario_id: "bdd.ads.rewarded",
      given: [{ text: "Given SDK 已初始化", source_ref_ids: ["src.bdd"] }],
      when: [{ text: "When 展示激励广告", source_ref_ids: ["src.bdd"] }],
      then: [{ text: "Then 回调奖励结果", source_ref_ids: ["src.bdd"] }],
    },
    source_refs: [sourceRef("src.bdd")],
    evidence_refs: [evidenceRef("ev.bdd", ["src.bdd"])],
    implementation_hints: [{
      hint_id: "hint.ads",
      kind: "symbol",
      ref: "AdsManager.ShowRewarded",
      summary: "Verifier 可从该符号开始定位广告展示链路。",
      source_ref_ids: ["src.bdd"],
    }],
    uncertainty_items: [],
    replay_context: replayContext(),
  };

  assert.deepEqual(validateDomainValidationArtifact(artifact), []);
});

test("domain validation artifact validator rejects verified report without evidence refs", () => {
  const artifact = {
    artifact_type: "VerificationReport",
    artifact_version: 1,
    artifact_id: "verification-1",
    run_id: "run-1",
    task_id: "task-verifier",
    status: "verified",
    bdd_ref: {
      scenario_id: "bdd.ads.rewarded",
      given: [{ text: "Given SDK 已初始化", source_ref_ids: ["src.bdd"] }],
      when: [{ text: "When 展示激励广告", source_ref_ids: ["src.bdd"] }],
      then: [{ text: "Then 回调奖励结果", source_ref_ids: ["src.bdd"] }],
    },
    research_artifact_refs: [artifactRef("art.research", "ResearchArtifact", "researcher", "task-research")],
    source_refs: [sourceRef("src.bdd")],
    evidence_refs: [],
    evidence_matrix: [],
    code_evidence: [],
    knowledge_evidence_ref_ids: [],
    gaps_and_risks: [],
    replay_context: replayContext(),
  };

  assert.match(validateDomainValidationArtifact(artifact).join("\n"), /verified requires evidence_matrix/);
});

test("validation state reducer requests BDD before worker dispatch", () => {
  const snapshot = buildValidationStateSnapshot({
    runId: "run-1",
    snapshotId: "snap-1",
    observedAt: "2026-06-29T00:00:00.000Z",
  });

  assert.equal(snapshot.current_state, "missing_bdd");
  assert.deepEqual(snapshot.allowed_actions, ["request_bdd", "request_user_input"]);
  assert.equal(snapshot.next_step, "向用户请求 BDD 或等价验证输入。");
});

test("validation state reducer reaches accepted only after validator accepted evidence", () => {
  const userInputs: UserInputObservation[] = [{
    input_id: "input-bdd",
    kind: "bdd",
    summary: "用户提供 BDD。",
    observed_at: "2026-06-29T00:00:00.000Z",
  }];
  const workerOutcomes: WorkerOutcomeObservation[] = [
    workerOutcome("task-research", "researcher", "ResearchArtifact", "art.research", "ev.research", "2026-06-29T00:01:00.000Z"),
    workerOutcome("task-verifier", "verifier", "VerificationReport", "art.verification", "ev.verification", "2026-06-29T00:02:00.000Z"),
    workerOutcome("task-validator", "validator", "ValidationResult", "art.validation", "ev.validation", "2026-06-29T00:03:00.000Z"),
  ];

  const snapshot = buildValidationStateSnapshot({
    runId: "run-1",
    snapshotId: "snap-accepted",
    observedAt: "2026-06-29T00:04:00.000Z",
    userInputs,
    workerOutcomes,
  });

  assert.equal(snapshot.current_state, "accepted");
  assert.equal(snapshot.latest_gate_status, "accepted");
  assert.deepEqual(snapshot.allowed_actions, ["synthesize"]);
  assert.equal(snapshot.artifact_refs.length, 3);
  assert.equal(snapshot.evidence_refs.length, 3);
});

test("validation state reducer exposes the next worker state without hardcoded prompts", () => {
  const userInputs: UserInputObservation[] = [{
    input_id: "input-bdd",
    kind: "bdd",
    summary: "用户提供 BDD。",
    observed_at: "2026-06-29T00:00:00.000Z",
  }];
  const researchRequired = buildValidationStateSnapshot({
    runId: "run-1",
    snapshotId: "snap-research-required",
    observedAt: "2026-06-29T00:01:00.000Z",
    userInputs,
  });
  assert.equal(researchRequired.current_state, "research_required");
  assert.deepEqual(researchRequired.allowed_actions, ["dispatch_researcher", "request_user_input"]);

  const verificationRequired = buildValidationStateSnapshot({
    runId: "run-1",
    snapshotId: "snap-verification-required",
    observedAt: "2026-06-29T00:02:00.000Z",
    userInputs,
    workerOutcomes: [
      workerOutcome("task-research", "researcher", "ResearchArtifact", "art.research", "ev.research", "2026-06-29T00:01:30.000Z"),
    ],
  });
  assert.equal(verificationRequired.current_state, "verification_required");
  assert.deepEqual(verificationRequired.allowed_actions, ["dispatch_verifier", "request_user_input"]);

  const validationRequired = buildValidationStateSnapshot({
    runId: "run-1",
    snapshotId: "snap-validation-required",
    observedAt: "2026-06-29T00:03:00.000Z",
    userInputs,
    workerOutcomes: [
      workerOutcome("task-research", "researcher", "ResearchArtifact", "art.research", "ev.research", "2026-06-29T00:01:30.000Z"),
      workerOutcome("task-verifier", "verifier", "VerificationReport", "art.verification", "ev.verification", "2026-06-29T00:02:30.000Z"),
    ],
  });
  assert.equal(validationRequired.current_state, "validation_required");
  assert.deepEqual(validationRequired.allowed_actions, ["dispatch_validator"]);
});

function workerOutcome(
  taskId: string,
  agentRole: WorkerOutcomeObservation["agent_role"],
  artifactType: ArtifactRef["artifact_type"],
  artifactId: string,
  evidenceId: string,
  observedAt: string,
): WorkerOutcomeObservation {
  return {
    task_id: taskId,
    agent_role: agentRole,
    status: "complete",
    summary: `${agentRole} complete`,
    artifact_refs: [artifactRef(artifactId, artifactType, agentRole, taskId)],
    evidence_refs: [evidenceRef(evidenceId, ["src.bdd"])],
    observed_at: observedAt,
  };
}

function artifactRef(
  artifactId: string,
  artifactType: ArtifactRef["artifact_type"],
  role: ArtifactRef["agent_role"],
  taskId: string,
): ArtifactRef {
  return {
    artifact_ref_id: artifactId,
    artifact_type: artifactType,
    uri: `artifacts/${artifactId}.json`,
    agent_role: role,
    task_id: taskId,
    produced_at: "2026-06-29T00:00:00.000Z",
  };
}

function sourceRef(id: string): SourceRef {
  return {
    source_ref_id: id,
    type: "bdd",
    collection_method: "user-confirmation",
    ref: "bdd.ads.rewarded",
    uri: "user-input://bdd",
    locator: {
      kind: "user_confirmation",
      value: "input-bdd",
    },
    summary: "用户提供的 BDD。",
  };
}

function evidenceRef(id: string, sourceIds: string[]): EvidenceRef {
  return {
    evidence_ref_id: id,
    type: "bdd",
    ref: id,
    summary: "BDD 输入证据。",
    source_ref_ids: sourceIds,
  };
}

function replayContext(): {
  run_id: string;
  asset_commit_id: string;
  agent_profile: string;
  knowledge_roots: string[];
  codebase_refs: string[];
  commands: string[];
} {
  return {
    run_id: "run-1",
    asset_commit_id: "ac_test",
    agent_profile: "researcher",
    knowledge_roots: ["/Users/chengdai/.guru/knowledge"],
    codebase_refs: ["gurusdk-unity@sdk/test"],
    commands: [],
  };
}

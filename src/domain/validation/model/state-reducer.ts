import type {
  ArtifactRef,
  EvidenceRef,
  UserInputObservation,
  ValidationCoordinatorAction,
  ValidationDomainState,
  ValidationGateStatus,
  ValidationStateSnapshot,
  ValidationStateTransition,
  WorkerOutcomeObservation,
} from "../schema/index.js";

export interface BuildValidationStateSnapshotInput {
  runId: string;
  snapshotId: string;
  observedAt: string;
  userInputs?: UserInputObservation[];
  workerOutcomes?: WorkerOutcomeObservation[];
  previousSnapshot?: ValidationStateSnapshot;
}

export function buildValidationStateSnapshot(input: BuildValidationStateSnapshotInput): ValidationStateSnapshot {
  const userInputs = dedupeBy(input.userInputs ?? [], (item) => item.input_id);
  const workerOutcomes = dedupeBy(input.workerOutcomes ?? [], (item) => item.task_id);
  const currentState = inferValidationDomainState({ userInputs, workerOutcomes });
  const previousState = input.previousSnapshot?.current_state ?? "missing_bdd";
  const transition = buildTransition({
    fromState: previousState,
    toState: currentState,
    action: primaryActionForState(currentState),
    observedAt: input.observedAt,
    userInputs,
    workerOutcomes,
  });
  const transitions = [
    ...(input.previousSnapshot?.transitions ?? []),
    ...(transition ? [transition] : []),
  ];

  return {
    artifact_type: "ValidationStateSnapshot",
    artifact_version: 1,
    snapshot_id: input.snapshotId,
    run_id: input.runId,
    current_state: currentState,
    allowed_actions: allowedActionsForState(currentState),
    user_inputs: userInputs,
    worker_outcomes: workerOutcomes,
    artifact_refs: collectArtifactRefs(workerOutcomes),
    evidence_refs: collectEvidenceRefs(workerOutcomes),
    latest_gate_status: latestGateStatus(workerOutcomes),
    transitions,
    blocker: blockerForState(currentState, workerOutcomes),
    next_step: nextStepForState(currentState, workerOutcomes),
  };
}

export function inferValidationDomainState(input: {
  userInputs?: UserInputObservation[];
  workerOutcomes?: WorkerOutcomeObservation[];
}): ValidationDomainState {
  const userInputs = input.userInputs ?? [];
  const workerOutcomes = input.workerOutcomes ?? [];
  const hasBdd = userInputs.some((item) => item.kind === "bdd");
  if (!hasBdd) return "missing_bdd";

  const latestBlocking = latestOutcomeWithStatus(workerOutcomes, ["blocked", "failed"]);
  if (latestBlocking?.status === "failed") return "failed";
  if (latestBlocking?.status === "blocked") return "blocked";

  const latestInsufficient = latestOutcomeWithStatus(workerOutcomes, ["insufficient_evidence"]);
  if (latestInsufficient) return "insufficient_evidence";

  const researcher = latestRoleOutcome(workerOutcomes, "researcher");
  if (!researcher) return "research_required";
  if (researcher.status === "prompt_required" || researcher.status === "confirmation_required") return "research_required";
  if (researcher.status !== "complete") return "research_running";
  if (!hasArtifactType(researcher, "ResearchArtifact")) return "research_required";

  const verifier = latestRoleOutcome(workerOutcomes, "verifier");
  if (!verifier) return "verification_required";
  if (verifier.status === "prompt_required" || verifier.status === "confirmation_required") return "verification_required";
  if (verifier.status !== "complete") return "verification_running";
  if (!hasArtifactType(verifier, "VerificationReport")) return "verification_required";

  const validator = latestRoleOutcome(workerOutcomes, "validator");
  if (!validator) return "validation_required";
  if (validator.status === "prompt_required" || validator.status === "confirmation_required") return "validation_required";
  if (validator.status !== "complete") return "validation_running";
  if (!hasArtifactType(validator, "ValidationResult")) return "validation_required";

  const gate = latestGateStatus(workerOutcomes);
  if (gate === "accepted") return "accepted";
  if (gate === "insufficient_evidence") return "insufficient_evidence";
  if (gate === "blocked") return "blocked";
  if (gate === "failed") return "failed";
  return "needs_fix";
}

export function allowedActionsForState(state: ValidationDomainState): ValidationCoordinatorAction[] {
  switch (state) {
    case "missing_bdd":
      return ["request_bdd", "request_user_input"];
    case "research_required":
      return ["dispatch_researcher", "request_user_input"];
    case "research_running":
      return ["send_message", "stop"];
    case "research_ready":
    case "verification_required":
      return ["dispatch_verifier", "request_user_input"];
    case "verification_running":
      return ["send_message", "stop"];
    case "verification_complete":
    case "validation_required":
      return ["dispatch_validator"];
    case "validation_running":
      return ["send_message", "stop"];
    case "accepted":
      return ["synthesize"];
    case "needs_fix":
      return ["send_message", "dispatch_researcher", "dispatch_verifier", "dispatch_validator"];
    case "insufficient_evidence":
      return ["request_user_input", "send_message", "synthesize"];
    case "blocked":
    case "failed":
      return ["request_user_input", "stop", "synthesize"];
  }
}

function buildTransition(input: {
  fromState: ValidationDomainState;
  toState: ValidationDomainState;
  action: ValidationCoordinatorAction;
  observedAt: string;
  userInputs: UserInputObservation[];
  workerOutcomes: WorkerOutcomeObservation[];
}): ValidationStateTransition | undefined {
  if (input.fromState === input.toState) return undefined;
  return {
    from_state: input.fromState,
    to_state: input.toState,
    action: input.action,
    reason: transitionReason(input.toState),
    evidence_ref_ids: collectEvidenceRefs(input.workerOutcomes).map((item) => item.evidence_ref_id),
    artifact_ref_ids: collectArtifactRefs(input.workerOutcomes).map((item) => item.artifact_ref_id),
    occurred_at: input.observedAt,
  };
}

function primaryActionForState(state: ValidationDomainState): ValidationCoordinatorAction {
  return allowedActionsForState(state)[0] ?? "synthesize";
}

function transitionReason(state: ValidationDomainState): string {
  switch (state) {
    case "missing_bdd":
      return "当前 run 未观察到 BDD 输入。";
    case "research_required":
      return "已观察到 BDD，但尚未观察到可用 ResearchArtifact。";
    case "verification_required":
      return "ResearchArtifact 已可用，需要 Verifier 进行证据验证。";
    case "validation_required":
      return "VerificationReport 已可用，需要 Validator gate。";
    case "accepted":
      return "Validator gate accepted，状态可进入 synthesis。";
    case "needs_fix":
      return "Validator gate 未接受，需要修复 artifact 或证据链。";
    case "insufficient_evidence":
      return "worker outcome 显示证据不足。";
    case "blocked":
      return "worker outcome 显示当前状态阻塞。";
    case "failed":
      return "worker outcome 显示失败。";
    default:
      return `状态进入 ${state}。`;
  }
}

function nextStepForState(state: ValidationDomainState, workerOutcomes: WorkerOutcomeObservation[]): string {
  const latest = latestOutcome(workerOutcomes);
  if (latest?.next_step) return latest.next_step;
  switch (state) {
    case "missing_bdd":
      return "向用户请求 BDD 或等价验证输入。";
    case "research_required":
      return "调度 Researcher 生成 ResearchArtifact。";
    case "verification_required":
      return "调度 Verifier 生成 VerificationReport。";
    case "validation_required":
      return "调度 Validator 生成 ValidationResult。";
    case "accepted":
      return "由 Coordinator 基于当前 Validation State 输出最终 synthesis。";
    case "needs_fix":
      return "根据 ValidationResult minimum fixes 路由对应 worker 修复。";
    case "insufficient_evidence":
      return "请求补充证据或说明证据不足结论。";
    case "blocked":
    case "failed":
      return "报告阻塞或失败原因，并请求用户决策。";
    default:
      return "等待当前 worker task 完成或继续推进。";
  }
}

function blockerForState(state: ValidationDomainState, workerOutcomes: WorkerOutcomeObservation[]): string | undefined {
  if (state !== "blocked" && state !== "failed") return undefined;
  return latestOutcome(workerOutcomes)?.blocker ?? latestOutcome(workerOutcomes)?.summary;
}

function latestGateStatus(workerOutcomes: WorkerOutcomeObservation[]): ValidationGateStatus | undefined {
  const validator = latestRoleOutcome(workerOutcomes, "validator");
  if (!validator) return undefined;
  const artifactTypes = validator.artifact_refs.map((item) => item.artifact_type);
  if (!artifactTypes.includes("ValidationResult")) return undefined;
  if (validator.status === "complete" && validator.evidence_refs.length > 0) return "accepted";
  if (validator.status === "insufficient_evidence") return "insufficient_evidence";
  if (validator.status === "blocked") return "blocked";
  if (validator.status === "failed") return "failed";
  return "needs_fix";
}

function collectArtifactRefs(workerOutcomes: WorkerOutcomeObservation[]): ArtifactRef[] {
  return dedupeBy(workerOutcomes.flatMap((item) => item.artifact_refs), (item) => item.artifact_ref_id);
}

function collectEvidenceRefs(workerOutcomes: WorkerOutcomeObservation[]): EvidenceRef[] {
  return dedupeBy(workerOutcomes.flatMap((item) => item.evidence_refs), (item) => item.evidence_ref_id);
}

function hasArtifactType(outcome: WorkerOutcomeObservation, artifactType: ArtifactRef["artifact_type"]): boolean {
  return outcome.artifact_refs.some((item) => item.artifact_type === artifactType);
}

function latestOutcome(workerOutcomes: WorkerOutcomeObservation[]): WorkerOutcomeObservation | undefined {
  return [...workerOutcomes].sort((left, right) => right.observed_at.localeCompare(left.observed_at))[0];
}

function latestOutcomeWithStatus(
  workerOutcomes: WorkerOutcomeObservation[],
  statuses: WorkerOutcomeObservation["status"][],
): WorkerOutcomeObservation | undefined {
  return [...workerOutcomes]
    .filter((item) => statuses.includes(item.status))
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at))[0];
}

function latestRoleOutcome(
  workerOutcomes: WorkerOutcomeObservation[],
  role: WorkerOutcomeObservation["agent_role"],
): WorkerOutcomeObservation | undefined {
  return [...workerOutcomes]
    .filter((item) => item.agent_role === role)
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at))[0];
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

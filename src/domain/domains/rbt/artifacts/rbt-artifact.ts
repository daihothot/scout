import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AgentEvents } from "../../../../agent/events/index.js";
import type { AgentTaskOutcomeSubmission } from "../../../../agent/task/task-events.js";
import type { UnsubscribeEventHandler } from "../../../../core/events/index.js";
import { parseArtifactReference, resolveArtifactTarget, type ScoutArtifactReference } from "../../../../core/io/index.js";
import { currentRunScope } from "../../../../run/run-scope.js";
import { SystemEvents } from "../../../../system/events/index.js";
import { RbtEvents, type RbtCampaignExecutionHistoryFileEvent } from "../rbt-events.js";
import type {
  RbtArtifactData, RbtArtifactReference, RbtExecutionHistory, RbtExecutionHistoryReference,
  RbtExecutionPackSubmission, RbtReviewResult, RbtReviewSubmission,
} from "./types.js";

/** Extracts and publishes RBT file facts, never from Outcome text; not a full document-format validator. */
export class RbtArtifact {
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private data: RbtArtifactData = { histories: new Map(), executionPacks: [], acceptedSubmissions: new Set() };

  /** The Domain restores previously published facts without replaying them to consumers. */
  restore(data: RbtArtifactData): void {
    this.data = data;
  }

  clear(): void {
    this.data.histories.clear();
    this.data.executionPacks.length = 0;
    this.data.acceptedSubmissions.clear();
  }

  start(): void {
    if (this.unsubscribers.length) return;
    const scope = currentRunScope();
    const warn = (error: unknown, data: Record<string, unknown>) => {
      const message = `RBT artifact fact was not published: ${error instanceof Error ? error.message : String(error)}`;
      scope.logger.warn({ module: "domain.rbt.artifacts", event: "rbt_artifact_record_failed", message, data });
      scope.eventBus.publish(SystemEvents.interaction.disclosureRequested, { level: "warn", source: "domain.rbt.artifacts", message });
    };
    this.unsubscribers.push(scope.eventBus.subscribe<RbtCampaignExecutionHistoryFileEvent>(RbtEvents.history.campaignExecutionHistory, async (event) => {
      try {
        const history = this.readHistory(event.payload);
        const previous = this.data.histories.get(history.executorHistoryRef);
        if (previous) {
          if (previous.history.executorHistoryDigest !== history.executorHistoryDigest) throw new Error("A finalized execution history was modified.");
          return;
        }
        this.data.histories.set(history.executorHistoryRef, { history, occurredAt: event.occurredAt });
        await scope.eventBus.publishAndWait(RbtEvents.history.ready, structuredClone(history), { occurredAt: event.occurredAt });
      } catch (error) {
        warn(error, { executorHistoryRef: event.payload.executorHistoryRef });
      }
    }));
    this.unsubscribers.push(scope.eventBus.subscribe<AgentTaskOutcomeSubmission>(AgentEvents.task.outcomeSubmitted, async (event) => {
      const { task, stepId, submittedAt } = event.payload;
      if (task.phase !== "execute" && task.phase !== "review") return;
      try {
        await this.captureHandoff({ task, stepId, submittedAt });
      } catch (error) {
        warn(error, { taskId: task.taskId, stepId });
      }
    }));
  }

  stop(): void {
    while (this.unsubscribers.length) this.unsubscribers.pop()?.();
    this.clear();
  }

  private async captureHandoff(input: Pick<AgentTaskOutcomeSubmission, "task" | "stepId" | "submittedAt">): Promise<void> {
    const scope = currentRunScope();
    const workflow = scope.workflow.snapshot();
    if (!workflow) throw new Error("RBT artifact submission requires an active Workflow.");
    const workflowId = workflow.workflowId;
    const submissionId = `${input.task.taskId}\0${input.stepId}`;
    const { agentId, phase } = input.task;
    const artifactRoot = scope.workflow.agentPaths(agentId).artifactRoot;
    const formalFile = phase === "execute" ? "execute-file.json" : "review-pack/review-result.json";
    const packDirectory = phase === "execute" ? "execute-pack" : "review-pack";

    const executedInputs = new Map<string, { bddId: string; targetVersion: string; packPath: string; source: ScoutArtifactReference }>();
    if (phase === "execute") {
      for (const { history } of this.data.histories.values()) {
        if (history.agentId !== agentId) continue;
        executedInputs.set(`${history.bddId}\0${history.targetVersion}`, {
          bddId: history.bddId, targetVersion: history.targetVersion,
          packPath: `${history.bddId}/${history.targetVersion}/${packDirectory}`,
          source: parseArtifactReference(history.executeFileRef),
        });
      }
    }

    // Actual execution identifies the input. File discovery covers formal deliveries without an execution.
    // Keep discovery incremental so a later scan failure does not suppress earlier published facts.
    function* formalPacks() {
      yield* executedInputs.values();
      for (const bdd of readdirSync(artifactRoot, { withFileTypes: true })) {
        if (!bdd.isDirectory()) continue;
        for (const version of readdirSync(join(artifactRoot, bdd.name), { withFileTypes: true })) {
          if (!version.isDirectory()) continue;
          const prefix = `${bdd.name}/${version.name}`;
          if (executedInputs.has(`${bdd.name}\0${version.name}`)) continue;
          if (!existsSync(join(artifactRoot, prefix, formalFile))) continue;
          yield { bddId: bdd.name, targetVersion: version.name, packPath: `${prefix}/${packDirectory}`,
            source: { workflowId, agentId, path: `${prefix}/${formalFile}` } };
        }
      }
    }

    let captured = 0;
    const failures: unknown[] = [];
    for (const { bddId, targetVersion, packPath, source } of formalPacks()) {
      captured += 1;
      const artifactSubmissionId = `${submissionId}\0${source.workflowId}\0${source.agentId}\0${packPath}`;
      if (this.data.acceptedSubmissions.has(artifactSubmissionId)) continue;
      const submission = {
        bddId, targetVersion, taskId: input.task.taskId, stepId: input.stepId, submittedAt: input.submittedAt,
      };
      try {
        if (phase === "execute") {
          const fact = this.captureExecutionPack(source, submission);
          this.data.executionPacks.push(fact);
          this.data.acceptedSubmissions.add(artifactSubmissionId);
          await scope.eventBus.publishAndWait(RbtEvents.artifact.executionPackSubmitted, structuredClone(fact), { occurredAt: input.submittedAt });
        } else {
          const fact = this.captureReview(agentId, submission);
          this.data.acceptedSubmissions.add(artifactSubmissionId);
          await scope.eventBus.publishAndWait(RbtEvents.artifact.reviewSubmitted, structuredClone(fact), { occurredAt: input.submittedAt });
        }
      } catch (error) { failures.push(error); }
    }
    if (captured === 0) throw new Error("No formal RBT artifact files were found for the submitting Agent.");
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "RBT artifact files failed validation.");
  }

  private captureExecutionPack(source: ScoutArtifactReference, submission: Omit<RbtExecutionPackSubmission, "pack">): RbtExecutionPackSubmission {
    const { bddId, targetVersion } = submission;
    const prefix = `${bddId}/${targetVersion}`;
    const executeFile = this.artifact(source, "sha256");
    const pack = this.artifact({ ...source, path: `${prefix}/execute-pack` }, "scout-directory-sha256-v1");
    // Existence and content identity are not format-validity or execution-success claims.
    return { ...submission, pack: { ...pack, executeFile } };
  }

  private readHistory(input: Pick<RbtExecutionHistory, "agentId" | "role" | "runtimeSequence" | "executorHistoryRef" | "executorHistoryDigest">): RbtExecutionHistory {
    const scope = currentRunScope();
    const workflow = scope.workflow.snapshot();
    if (!workflow) throw new Error("RBT execution history requires an active Workflow.");
    const historyPath = `history/${String(input.runtimeSequence).padStart(3, "0")}.json`;
    const root = `scout-artifact://${workflow.workflowId}/${input.agentId}/`;
    if (input.executorHistoryRef !== `${root}${historyPath}`) throw new Error("Execution history reference does not match its Workflow and Agent.");
    const { reference: file, content } = this.readArtifactFile({ workflowId: workflow.workflowId, agentId: input.agentId, path: historyPath });
    if (file.digest !== input.executorHistoryDigest) throw new Error("Execution history changed after it was finalized.");
    const value: unknown = JSON.parse(content.toString("utf8"));
    if (!isRecord(value)) throw new Error("Execution history must be an object.");
    const required = (key: string): string => {
      const field = value[key];
      if (typeof field !== "string" || !field.trim()) throw new Error(`Execution history ${key} must be a non-empty string.`);
      return field;
    };
    if (!Number.isSafeInteger(value.runtimeSequence)
      || value.runtimeSequence !== input.runtimeSequence || input.runtimeSequence < 1) {
      throw new Error("Execution history sequence differs from its file identity.");
    }
    if (value.status !== "completed" && value.status !== "failed") throw new Error("Execution history is not finalized.");
    const platform = value.platform;
    if (!isRecord(platform) || typeof platform.type !== "string" || !platform.type.trim()
      || typeof platform.version !== "string" || !platform.version.trim()) {
      throw new Error("Execution history has an invalid platform.");
    }
    const executeFileRef = required("executeFileRef");
    const parts = parseArtifactReference(executeFileRef).path.split("/");
    if (parts.length !== 3 || parts[2] !== "execute-file.json") {
      throw new Error("Execution file must use <bdd-id>/<version>/execute-file.json.");
    }
    return {
      bddId: parts[0]!, targetVersion: parts[1]!, platform: { type: platform.type, version: platform.version },
      executeFileRef, executeFileDigest: required("executeFileDigest"),
      executorHistoryRef: input.executorHistoryRef, executorHistoryDigest: file.digest,
      runtimeSequence: input.runtimeSequence, campaignId: required("campaignId"), scenarioId: required("scenarioId"),
      status: value.status, agentId: input.agentId, role: input.role,
    };
  }

  private readReview(agentId: string, prefix: string) {
    const reviewPath = `${prefix}/review-pack/review-result.json`;
    const { content } = this.readArtifactFile({ workflowId: currentRunScope().workflow.snapshot()!.workflowId, agentId, path: reviewPath });
    const value: unknown = JSON.parse(content.toString("utf8"));
    if (!isRecord(value)) throw new Error("Review result must be an object.");
    const review = value;
    const required = (key: string): string => {
      const field = review[key];
      if (typeof field !== "string" || !field.trim()) throw new Error(`Review ${key} must be a non-empty string.`);
      return field;
    };
    if (review.scenarioId !== undefined && typeof review.scenarioId !== "string") throw new Error("Review scenarioId must be a string.");
    if (!Array.isArray(review.timeline) || !review.timeline.length) throw new Error("Review timeline must not be empty.");
    const statuses = new Set<"match" | "warning" | "not_match">();
    for (const entry of review.timeline) {
      if (!isRecord(entry)) throw new Error("Invalid review timeline point.");
      const point = entry;
      if (point.status !== "match" && point.status !== "warning" && point.status !== "not_match") {
        throw new Error("Invalid review timeline status.");
      }
      statuses.add(point.status);
    }

    // Summarize only the comparison statuses already recorded by the Reviewer.
    const result: RbtReviewResult = statuses.has("not_match") ? "fail" : statuses.has("warning") ? "attention" : "pass";
    return {
      bddId: required("bddId"), targetVersion: required("targetVersion"), campaignId: required("campaignId"),
      executorHistoryRef: required("executorHistoryRef"), scenarioId: review.scenarioId, result,
    };
  }

  private captureReview(agentId: string, submission: Omit<RbtReviewSubmission, "pack">): RbtReviewSubmission {
    const scope = currentRunScope();
    const workflow = scope.workflow.snapshot();
    if (!workflow) throw new Error("RBT review requires an active Workflow.");
    const { bddId, targetVersion } = submission;
    const prefix = `${bddId}/${targetVersion}`;
    const review = this.readReview(agentId, prefix);
    // Associate the formal Review with one published execution.
    if (review.bddId !== bddId || review.targetVersion !== targetVersion) throw new Error("Review identity differs from its Pack location.");
    const previous = this.data.histories.get(review.executorHistoryRef);
    if (!previous) throw new Error("Review must identify one published Executor history.");

    // Re-read finalized evidence; a published fact does not replace checking its current bytes.
    const history = this.readHistory(previous.history);
    if (history.bddId !== bddId || history.targetVersion !== targetVersion || history.campaignId !== review.campaignId
      || (review.scenarioId !== undefined && history.scenarioId !== review.scenarioId)) {
      throw new Error("Review does not match its execution history.");
    }
    const executeSource = parseArtifactReference(history.executeFileRef);
    const executePath = executeSource.path;
    const historyPath = `history/${String(history.runtimeSequence).padStart(3, "0")}.json`;
    // readHistory has just checked this file's ownership, bytes and digest.
    const executorHistory: RbtArtifactReference = {
      workflowId: workflow.workflowId, agentId: history.agentId, path: historyPath,
      algorithm: "sha256", digest: history.executorHistoryDigest,
    };
    const executeFile = this.artifact(executeSource, "sha256");
    if (executeFile.digest !== history.executeFileDigest) throw new Error("Reviewed execution evidence changed after execution.");

    // Match the execution to its formal Pack handoff and verify that Pack has not changed.
    const submitted = [...this.data.executionPacks].reverse().find((fact) =>
      fact.bddId === bddId && fact.targetVersion === targetVersion
      && fact.pack.executeFile.workflowId === executeSource.workflowId
      && fact.pack.executeFile.agentId === executeSource.agentId && fact.pack.executeFile.path === executePath
      && fact.pack.executeFile.digest === history.executeFileDigest);
    if (!submitted) throw new Error("Review has no matching formal Execution Pack handoff.");
    const executionPack = this.artifact(submitted.pack, "scout-directory-sha256-v1");
    if (executionPack.digest !== submitted.pack.digest) throw new Error("Execution Pack changed after its formal handoff.");

    // Capture the complete Reviewer Pack and link the exact evidence in the published fact.
    this.artifact({ workflowId: workflow.workflowId, agentId, path: `${prefix}/review-pack/review-report.html` }, "sha256");
    const pack = this.artifact({ workflowId: workflow.workflowId, agentId, path: `${prefix}/review-pack` }, "scout-directory-sha256-v1");
    const execution: RbtExecutionHistoryReference = {
      workflowId: workflow.workflowId, agentId: history.agentId, runtimeSequence: history.runtimeSequence,
      campaignId: history.campaignId, scenarioId: history.scenarioId, platform: { ...history.platform }, executeFile, executorHistory,
    };
    return { ...submission, pack: { ...pack, result: review.result, executionPack: submitted.pack, execution } };
  }

  /** JSON parsing and content identity use the same safely read bytes, without caching them. */
  private readArtifactFile(source: ScoutArtifactReference): { reference: RbtArtifactReference; content: Buffer } {
    const location = resolveArtifactTarget(source);
    if ("reason" in location) throw new Error(location.reason);
    const target = location.path;
    if (!lstatSync(target).isFile()) throw new Error("Expected a regular artifact file.");
    const content = readFileSync(target);
    const reference: RbtArtifactReference = {
      workflowId: source.workflowId, agentId: source.agentId, path: source.path, algorithm: "sha256",
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    };
    return { reference, content };
  }

  /** Same byte-level directory digest contract as scout-artifact-digest; neither real paths nor mtimes enter it. */
  private artifact(source: ScoutArtifactReference, algorithm: RbtArtifactReference["algorithm"]): RbtArtifactReference {
    if (algorithm === "sha256") return this.readArtifactFile(source).reference;
    const location = resolveArtifactTarget(source);
    if ("reason" in location) throw new Error(location.reason);
    const target = location.path;
    if (!lstatSync(target).isDirectory()) throw new Error("Expected an artifact directory.");
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("RBT artifact directories must not contain symlinks.");
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) files.push(child);
        else throw new Error("Unsupported RBT artifact directory entry.");
      }
    };
    visit(target);
    files.sort((left, right) => relative(target, left).localeCompare(relative(target, right)));
    const hash = createHash("sha256");
    for (const file of files) {
      const content = readFileSync(file);
      hash.update("file\0").update(relative(target, file).split(sep).join("/")).update("\0")
        .update(String(content.byteLength)).update("\0").update(content).update("\0");
    }
    return { workflowId: source.workflowId, agentId: source.agentId, path: source.path, algorithm, digest: `sha256:${hash.digest("hex")}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

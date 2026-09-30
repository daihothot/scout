import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { AgentEvents } from "../../../../agent/events/index.js";
import type { AgentTaskOutcomeSubmission } from "../../../../agent/task/task-events.js";
import type { UnsubscribeEventHandler } from "../../../../core/events/index.js";
import { isPathWithin } from "../../../../core/path.js";
import { currentRunScope } from "../../../../run/run-scope.js";
import { SystemEvents } from "../../../../system/events/index.js";
import {
  RbtEvents,
  type RbtCampaignExecutionHistoryFileEvent,
  type RbtExecutionHistoryReadyEvent,
  type RbtExecutionPackSubmittedEvent,
  type RbtReviewSubmittedEvent,
} from "../rbt-events.js";
import type { RbtArtifactReference, RbtExecutionHistoryReference, RbtReviewResult } from "./types.js";

/** Publishes RBT history and Pack facts from formal files, never from Outcome text. */
export class RbtArtifact {
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private readonly histories = new Map<string, RbtExecutionHistoryReadyEvent>();
  private readonly executionPacks: RbtExecutionPackSubmittedEvent[] = [];
  private readonly acceptedSubmissions = new Set<string>();

  /** The Domain restores previously published facts without replaying them to consumers. */
  restore(facts: {
    histories: readonly RbtExecutionHistoryReadyEvent[];
    executionPacks: readonly RbtExecutionPackSubmittedEvent[];
    reviews: readonly RbtReviewSubmittedEvent[];
  }): void {
    this.histories.clear();
    for (const history of facts.histories) this.histories.set(history.executorHistoryRef, structuredClone(history));
    this.executionPacks.splice(0, this.executionPacks.length, ...structuredClone(facts.executionPacks));
    this.acceptedSubmissions.clear();
    for (const fact of [...facts.executionPacks, ...facts.reviews]) {
      this.acceptedSubmissions.add(`${fact.taskId}\0${fact.stepId}\0${fact.pack.agentId}\0${fact.pack.path}`);
    }
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
        const previous = this.histories.get(history.executorHistoryRef);
        if (previous) {
          if (previous.executorHistoryDigest !== history.executorHistoryDigest) throw new Error("A finalized execution history was modified.");
          return;
        }
        this.histories.set(history.executorHistoryRef, history);
        await scope.eventBus.publishAndWait(RbtEvents.history.ready, history, { occurredAt: event.occurredAt });
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
    this.restore({ histories: [], executionPacks: [], reviews: [] });
  }

  private async captureHandoff(input: Pick<AgentTaskOutcomeSubmission, "task" | "stepId" | "submittedAt">): Promise<void> {
    const scope = currentRunScope();
    const workflow = scope.workflow.snapshot();
    if (!workflow) throw new Error("RBT artifact submission requires an active Workflow.");
    const submissionId = `${input.task.taskId}\0${input.stepId}`;
    const { agentId, phase } = input.task;
    const artifactRoot = scope.workflow.agentPaths(agentId).artifactRoot;
    let captured = 0;
    const failures: unknown[] = [];
    // Only the submitting Agent's two-level formal artifact layout is inspected.
    for (const bdd of readdirSync(artifactRoot, { withFileTypes: true })) {
      if (!bdd.isDirectory()) continue;
      for (const version of readdirSync(join(artifactRoot, bdd.name), { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        const prefix = `${bdd.name}/${version.name}`;
        const file = phase === "execute" ? `${prefix}/execute-file.json` : `${prefix}/review-pack/review-result.json`;
        if (!existsSync(join(artifactRoot, file))) continue;
        captured += 1;
        const packPath = `${prefix}/${phase === "execute" ? "execute-pack" : "review-pack"}`;
        const artifactSubmissionId = `${submissionId}\0${agentId}\0${packPath}`;
        if (this.acceptedSubmissions.has(artifactSubmissionId)) continue;
        const submission = { bddId: bdd.name, targetVersion: version.name, taskId: input.task.taskId, stepId: input.stepId, submittedAt: input.submittedAt };
        try {
          if (phase === "execute") {
            const fact = this.captureExecutionPack(agentId, submission);
            this.executionPacks.push(fact);
            this.acceptedSubmissions.add(artifactSubmissionId);
            await scope.eventBus.publishAndWait(RbtEvents.artifact.executionPackSubmitted, fact, { occurredAt: input.submittedAt });
          } else {
            const fact = this.captureReview(agentId, submission);
            this.acceptedSubmissions.add(artifactSubmissionId);
            await scope.eventBus.publishAndWait(RbtEvents.artifact.reviewSubmitted, fact, { occurredAt: input.submittedAt });
          }
        } catch (error) { failures.push(error); }
      }
    }
    if (captured === 0) throw new Error("No formal RBT artifact files were found for the submitting Agent.");
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "RBT artifact files failed validation.");
  }

  private captureExecutionPack(agentId: string, submission: Omit<RbtExecutionPackSubmittedEvent, "pack">): RbtExecutionPackSubmittedEvent {
    const { bddId, targetVersion } = submission;
    const prefix = `${bddId}/${targetVersion}`;
    const executeFile = this.artifact(agentId, `${prefix}/execute-file.json`, "sha256");
    const pack = this.artifact(agentId, `${prefix}/execute-pack`, "scout-directory-sha256-v1");
    // Existence and content identity are not format-validity or execution-success claims.
    return { ...submission, pack: { ...pack, executeFile } };
  }

  private readHistory(input: RbtCampaignExecutionHistoryFileEvent): RbtExecutionHistoryReadyEvent {
    const scope = currentRunScope();
    const workflow = scope.workflow.snapshot();
    if (!workflow) throw new Error("RBT execution history requires an active Workflow.");
    const historyPath = `history/${String(input.runtimeSequence).padStart(3, "0")}.json`;
    const root = `scout-artifact://${workflow.workflowId}/${input.agentId}/`;
    if (input.executorHistoryRef !== `${root}${historyPath}`) throw new Error("Execution history reference does not match its Workflow and Agent.");
    const file = this.artifact(input.agentId, historyPath, "sha256");
    if (file.digest !== input.executorHistoryDigest) throw new Error("Execution history changed after it was finalized.");
    const value: unknown = JSON.parse(readFileSync(join(scope.workflow.agentPaths(input.agentId).artifactRoot, historyPath), "utf8"));
    if (!isRecord(value)) throw new Error("Execution history must be an object.");
    const required = (key: string): string => {
      const field = value[key];
      if (typeof field !== "string" || !field.trim()) throw new Error(`Execution history ${key} must be a non-empty string.`);
      return field;
    };
    if (!Number.isSafeInteger(value.runtimeSequence) || value.runtimeSequence !== input.runtimeSequence || input.runtimeSequence < 1) throw new Error("Execution history sequence differs from its file identity.");
    if (value.status !== "completed" && value.status !== "failed") throw new Error("Execution history is not finalized.");
    const platform = value.platform;
    if (!isRecord(platform) || typeof platform.type !== "string" || !platform.type.trim()
      || typeof platform.version !== "string" || !platform.version.trim()) throw new Error("Execution history has an invalid platform.");
    const executeFileRef = required("executeFileRef");
    if (!executeFileRef.startsWith(root)) throw new Error("Execution file belongs to a different Workflow or Agent.");
    const parts = executeFileRef.slice(root.length).split("/");
    if (parts.length !== 3 || parts[2] !== "execute-file.json" || parts.some((part) => !part || part === "." || part === "..")) {
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
    const scope = currentRunScope();
    const reviewPath = `${prefix}/review-pack/review-result.json`;
    // The byte reader also enforces artifact containment before any JSON is consumed.
    this.artifact(agentId, reviewPath, "sha256");
    const value: unknown = JSON.parse(readFileSync(join(scope.workflow.agentPaths(agentId).artifactRoot, reviewPath), "utf8"));
    if (!isRecord(value)) throw new Error("Review result must be an object.");
    const review = value;
    const required = (key: string): string => {
      const field = review[key];
      if (typeof field !== "string" || !field.trim()) throw new Error(`Review ${key} must be a non-empty string.`);
      return field;
    };
    required("summary");
    if (review.scenarioId !== undefined && typeof review.scenarioId !== "string") throw new Error("Review scenarioId must be a string.");
    if (!Array.isArray(review.timeline) || !review.timeline.length) throw new Error("Review timeline must not be empty.");
    const ids = new Set<string>();
    let result: RbtReviewResult = "pass";
    for (const entry of review.timeline) {
      if (!isRecord(entry)) throw new Error("Invalid review timeline point.");
      const point = entry;
      if (typeof point.id !== "string" || !/^(?:JR|SR)-[0-9]+$/.test(point.id) || ids.has(point.id)) throw new Error("Invalid or duplicate review timeline id.");
      ids.add(point.id);
      if (typeof point.title !== "string" || !point.title.trim() || typeof point.comparison !== "string" || !point.comparison.trim()
        || !Object.hasOwn(point, "expected") || !Object.hasOwn(point, "actual")) throw new Error("Incomplete review timeline comparison.");
      if (point.note !== undefined && typeof point.note !== "string") throw new Error("Invalid review timeline note.");
      if (point.refs !== undefined) {
        if (!isRecord(point.refs)) throw new Error("Invalid review timeline refs.");
        for (const key of ["bdd", "journal", "signal", "runtime", "code"]) {
          const refs = point.refs[key];
          if (refs !== undefined && (!Array.isArray(refs) || !refs.every((ref) => typeof ref === "string"))) throw new Error("Invalid review timeline reference list.");
        }
      }
      if (point.status === "not_match") result = "fail";
      else if (point.status === "warning") { if (result !== "fail") result = "attention"; }
      else if (point.status !== "match") throw new Error("Invalid review timeline status.");
    }
    return {
      bddId: required("bddId"), targetVersion: required("targetVersion"), campaignId: required("campaignId"),
      executorHistoryRef: required("executorHistoryRef"), scenarioId: review.scenarioId, result,
    };
  }

  private captureReview(agentId: string, submission: Omit<RbtReviewSubmittedEvent, "pack">): RbtReviewSubmittedEvent {
    const scope = currentRunScope();
    const workflow = scope.workflow.snapshot();
    if (!workflow) throw new Error("RBT review requires an active Workflow.");
    const { bddId, targetVersion } = submission;
    const prefix = `${bddId}/${targetVersion}`;
    const review = this.readReview(agentId, prefix);
    if (review.bddId !== bddId || review.targetVersion !== targetVersion) throw new Error("Review identity differs from its Pack location.");
    const previous = this.histories.get(review.executorHistoryRef);
    if (!previous) throw new Error("Review must identify one published Executor history.");
    const history = this.readHistory(previous);
    if (history.bddId !== bddId || history.targetVersion !== targetVersion || history.campaignId !== review.campaignId
      || (review.scenarioId !== undefined && history.scenarioId !== review.scenarioId)) throw new Error("Review does not match its execution history.");
    const executePath = `${prefix}/execute-file.json`;
    const historyPath = `history/${String(history.runtimeSequence).padStart(3, "0")}.json`;
    if (history.executeFileRef !== `scout-artifact://${workflow.workflowId}/${history.agentId}/${executePath}`
      || history.executorHistoryRef !== `scout-artifact://${workflow.workflowId}/${history.agentId}/${historyPath}`) throw new Error("Review execution references belong to a different Workflow or Agent.");
    const executorHistory = this.artifact(history.agentId, historyPath, "sha256");
    const executeFile = this.artifact(history.agentId, executePath, "sha256");
    if (executorHistory.digest !== history.executorHistoryDigest || executeFile.digest !== history.executeFileDigest) throw new Error("Reviewed execution evidence changed after execution.");
    const submitted = [...this.executionPacks].reverse().find((fact) => fact.bddId === bddId && fact.targetVersion === targetVersion
      && fact.pack.executeFile.agentId === history.agentId && fact.pack.executeFile.path === executePath
      && fact.pack.executeFile.digest === history.executeFileDigest);
    if (!submitted) throw new Error("Review has no matching formal Execution Pack handoff.");
    const executionPack = this.artifact(history.agentId, `${prefix}/execute-pack`, "scout-directory-sha256-v1");
    if (executionPack.digest !== submitted.pack.digest) throw new Error("Execution Pack changed after its formal handoff.");
    this.artifact(agentId, `${prefix}/review-pack/review-report.html`, "sha256");
    const pack = this.artifact(agentId, `${prefix}/review-pack`, "scout-directory-sha256-v1");
    const execution: RbtExecutionHistoryReference = {
      workflowId: workflow.workflowId, agentId: history.agentId, runtimeSequence: history.runtimeSequence,
      campaignId: history.campaignId, scenarioId: history.scenarioId, platform: { ...history.platform }, executeFile, executorHistory,
    };
    return { ...submission, pack: { ...pack, result: review.result, executionPack: submitted.pack, execution } };
  }

  /** Same byte-level directory digest contract as scout-artifact-digest; neither real paths nor mtimes enter it. */
  private artifact(agentId: string, path: string, algorithm: RbtArtifactReference["algorithm"]): RbtArtifactReference {
    const workflow = currentRunScope().workflow;
    const state = workflow.snapshot();
    if (!state) throw new Error("RBT artifact capture requires an active Workflow.");
    const root = workflow.agentPaths(agentId).artifactRoot;
    const target = resolve(root, path);
    if (!isPathWithin(root, target, { allowRoot: false })) throw new Error("RBT artifact path escapes its Agent root.");
    const segments = path.split("/");
    for (const [index] of segments.entries()) {
      if (lstatSync(join(root, ...segments.slice(0, index + 1))).isSymbolicLink()) throw new Error("RBT artifact references must not traverse symlinks.");
    }
    const hash = createHash("sha256");
    if (algorithm === "sha256") {
      if (!lstatSync(target).isFile()) throw new Error("Expected a regular artifact file.");
      hash.update(readFileSync(target));
    } else {
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
      for (const file of files) {
        const content = readFileSync(file);
        hash.update("file\0").update(relative(target, file).split(sep).join("/")).update("\0")
          .update(String(content.byteLength)).update("\0").update(content).update("\0");
      }
    }
    return { workflowId: state.workflowId, agentId, path, algorithm, digest: `sha256:${hash.digest("hex")}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AgentEvents } from "../../../../agent/events/index.js";
import type { AgentTaskOutcomeSubmission } from "../../../../agent/task/task-events.js";
import type { UnsubscribeEventHandler } from "../../../../core/events/index.js";
import { parseArtifactReference, formatArtifactReference, readArtifactReference, resolveArtifactTarget, type ScoutArtifactReference } from "../../../../core/io/index.js";
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
    const submission = { taskId: input.task.taskId, stepId: input.stepId, submittedAt: input.submittedAt };
    if (phase === "execute") {
      // Execution history identifies the actual Pack owner. An unexecuted formal delivery belongs to its writer.
      const history = [...this.data.histories.values()]
        .filter(({ history }) => history.agentId === agentId)
        .sort((left, right) => right.history.runtimeSequence - left.history.runtimeSequence)[0]?.history;
      const source: ScoutArtifactReference = history ? parseArtifactReference(history.executeFileRef)
        : { workflowId, agentId, internalSymbols: ["pack", "execute-file.json"] };
      const key = `${submissionId}\0${formatArtifactReference({ ...source, internalSymbols: ["pack"] })}`;
      if (this.data.acceptedSubmissions.has(key)) return;
      const fact = this.captureExecutionPack(source, submission);
      this.data.executionPacks.push(fact);
      this.data.acceptedSubmissions.add(key);
      await scope.eventBus.publishAndWait(RbtEvents.artifact.executionPackSubmitted, structuredClone(fact), { occurredAt: input.submittedAt });
    } else {
      const key = `${submissionId}\0${formatArtifactReference({ workflowId, agentId, internalSymbols: ["pack"] })}`;
      if (this.data.acceptedSubmissions.has(key)) return;
      const fact = this.captureReview(agentId, submission);
      this.data.acceptedSubmissions.add(key);
      await scope.eventBus.publishAndWait(RbtEvents.artifact.reviewSubmitted, structuredClone(fact), { occurredAt: input.submittedAt });
    }
  }

  private captureExecutionPack(
    source: ScoutArtifactReference, submission: Pick<RbtExecutionPackSubmission, "taskId" | "stepId" | "submittedAt">,
  ): RbtExecutionPackSubmission {
    const { reference: executeFile, content } = this.readArtifactFile(source);
    const value: unknown = JSON.parse(content.toString("utf8"));
    if (!isRecord(value) || typeof value.bddId !== "string" || !value.bddId.trim()
      || typeof value.targetVersion !== "string" || !value.targetVersion.trim()) {
      throw new Error("Execution file requires bddId and targetVersion.");
    }
    const pack = this.artifact({ ...source, internalSymbols: ["pack"] }, "scout-directory-sha256-v1");
    return { ...submission, bddId: value.bddId, targetVersion: value.targetVersion, pack: { ...pack, executeFile } };
  }

  private readHistory(input: Pick<RbtExecutionHistory, "agentId" | "role" | "runtimeSequence" | "executorHistoryRef" | "executorHistoryDigest">): RbtExecutionHistory {
    const scope = currentRunScope();
    const workflow = scope.workflow.snapshot();
    if (!workflow) throw new Error("RBT execution history requires an active Workflow.");
    const historyPath = `history/${String(input.runtimeSequence).padStart(3, "0")}.json`;
    const historyReference = { workflowId: workflow.workflowId, agentId: input.agentId, internalSymbols: historyPath.split("/") };
    if (input.executorHistoryRef !== formatArtifactReference(historyReference)) throw new Error("Execution history reference does not match its Workflow and Agent.");
    const { reference: file, content } = this.readArtifactFile(historyReference);
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
    const executeSource = readArtifactReference(value.executeFileRef);
    const executeFileRef = formatArtifactReference(executeSource);
    if (executeSource.internalSymbols.join("/") !== "pack/execute-file.json") {
      throw new Error("Execution file must reference pack/execute-file.json.");
    }
    return {
      bddId: required("bddId"), targetVersion: required("targetVersion"), platform: { type: platform.type, version: platform.version },
      executeFileRef, executeFileDigest: required("executeFileDigest"),
      executorHistoryRef: input.executorHistoryRef, executorHistoryDigest: file.digest,
      runtimeSequence: input.runtimeSequence, campaignId: required("campaignId"), scenarioId: required("scenarioId"),
      status: value.status, agentId: input.agentId, role: input.role,
    };
  }

  private readReview(agentId: string) {
    const reviewPath = ["pack", "review-result.json"];
    const { content } = this.readArtifactFile({ workflowId: currentRunScope().workflow.snapshot()!.workflowId, agentId, internalSymbols: reviewPath });
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
      executorHistoryRef: formatArtifactReference(readArtifactReference(review.executorHistoryRef)), scenarioId: review.scenarioId, result,
    };
  }

  private captureReview(agentId: string, submission: Pick<RbtReviewSubmission, "taskId" | "stepId" | "submittedAt">): RbtReviewSubmission {
    const scope = currentRunScope();
    const workflow = scope.workflow.snapshot();
    if (!workflow) throw new Error("RBT review requires an active Workflow.");
    const review = this.readReview(agentId);
    const { bddId, targetVersion } = review;
    // Associate the formal Review with one published execution.
    const previous = this.data.histories.get(review.executorHistoryRef);
    if (!previous) throw new Error("Review must identify one published Executor history.");

    // Re-read finalized evidence; a published fact does not replace checking its current bytes.
    const history = this.readHistory(previous.history);
    if (history.bddId !== bddId || history.targetVersion !== targetVersion || history.campaignId !== review.campaignId
      || (review.scenarioId !== undefined && history.scenarioId !== review.scenarioId)) {
      throw new Error("Review does not match its execution history.");
    }
    const executeSource = parseArtifactReference(history.executeFileRef);
    const executeRef = formatArtifactReference(executeSource);
    const historyPath = `history/${String(history.runtimeSequence).padStart(3, "0")}.json`;
    // readHistory has just checked this file's ownership, bytes and digest.
    const executorHistory: RbtArtifactReference = {
      workflowId: workflow.workflowId, agentId: history.agentId, internalSymbols: historyPath.split("/"),
      algorithm: "sha256", digest: history.executorHistoryDigest,
    };
    const executeFile = this.artifact(executeSource, "sha256");
    if (executeFile.digest !== history.executeFileDigest) throw new Error("Reviewed execution evidence changed after execution.");

    // Match the execution to its formal Pack handoff and verify that Pack has not changed.
    const submitted = [...this.data.executionPacks].reverse().find((fact) =>
      fact.bddId === bddId && fact.targetVersion === targetVersion
      && fact.pack.executeFile.workflowId === executeSource.workflowId
      && fact.pack.executeFile.agentId === executeSource.agentId && formatArtifactReference(fact.pack.executeFile) === executeRef
      && fact.pack.executeFile.digest === history.executeFileDigest);
    if (!submitted) throw new Error("Review has no matching formal Execution Pack handoff.");
    const executionPack = this.artifact(submitted.pack, "scout-directory-sha256-v1");
    if (executionPack.digest !== submitted.pack.digest) throw new Error("Execution Pack changed after its formal handoff.");

    // Capture the complete Reviewer Pack and link the exact evidence in the published fact.
    this.artifact({ workflowId: workflow.workflowId, agentId, internalSymbols: ["pack", "review-report.html"] }, "sha256");
    const pack = this.artifact({ workflowId: workflow.workflowId, agentId, internalSymbols: ["pack"] }, "scout-directory-sha256-v1");
    const execution: RbtExecutionHistoryReference = {
      workflowId: workflow.workflowId, agentId: history.agentId, runtimeSequence: history.runtimeSequence,
      campaignId: history.campaignId, scenarioId: history.scenarioId, platform: { ...history.platform }, executeFile, executorHistory,
    };
    return { ...submission, bddId, targetVersion, pack: { ...pack, result: review.result, executionPack: submitted.pack, execution } };
  }

  /** JSON parsing and content identity use the same safely read bytes, without caching them. */
  private readArtifactFile(source: ScoutArtifactReference): { reference: RbtArtifactReference; content: Buffer } {
    const location = resolveArtifactTarget(source);
    if ("reason" in location) throw new Error(location.reason);
    const target = location.path;
    if (!lstatSync(target).isFile()) throw new Error("Expected a regular artifact file.");
    const content = readFileSync(target);
    const reference: RbtArtifactReference = {
      workflowId: source.workflowId, agentId: source.agentId, internalSymbols: [...source.internalSymbols], algorithm: "sha256",
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
    return { workflowId: source.workflowId, agentId: source.agentId, internalSymbols: [...source.internalSymbols], algorithm, digest: `sha256:${hash.digest("hex")}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

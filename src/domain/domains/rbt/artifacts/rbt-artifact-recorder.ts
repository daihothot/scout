import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { AgentEvents } from "../../../../agent/events/index.js";
import type { AgentTaskOutcomeSubmission } from "../../../../agent/task/task-events.js";
import { resolveAgentArtifactReferences } from "../../../../agent/task/artifact-references.js";
import type { UnsubscribeEventHandler } from "../../../../core/events/index.js";
import { isPathWithin } from "../../../../core/path.js";
import { currentRunScope } from "../../../../run/run-scope.js";
import { SystemEvents } from "../../../../system/events/index.js";
import type { RbtJournal } from "../rbt-journal.js";
import type { RbtArtifactReference, RbtExecutionHistoryReference, RbtReviewResult } from "./types.js";

/** Captures formal RBT artifact handoffs; Task completion itself carries no review verdict. */
export class RbtArtifactRecorder {
  private unsubscribe?: UnsubscribeEventHandler;

  constructor(private readonly journal: RbtJournal) {}

  start(): void {
    if (this.unsubscribe) return;
    const scope = currentRunScope();
    this.unsubscribe = scope.eventBus.subscribe<AgentTaskOutcomeSubmission>(AgentEvents.task.outcomeSubmitted, (event) => {
      if (event.payload.task.phase !== "execute" && event.payload.task.phase !== "review") return;
      try {
        this.record(event.payload);
      } catch (error) {
        const message = `RBT artifact handoff was not indexed: ${error instanceof Error ? error.message : String(error)}`;
        scope.logger.warn({ module: "domain.rbt.artifacts", event: "rbt_artifact_record_failed", message, data: { taskId: event.payload.task.taskId, stepId: event.payload.stepId } });
        scope.eventBus.publish(SystemEvents.interaction.disclosureRequested, { level: "warn", source: "domain.rbt.artifacts", message });
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private record(input: AgentTaskOutcomeSubmission): void {
    const scope = currentRunScope();
    const workflow = scope.workflow.snapshot();
    if (!workflow) throw new Error("RBT artifact submission requires an active Workflow.");
    const facts = this.journal.aggregate(this.journal.readAll());
    if ([...facts.executionPacks, ...facts.reviews].some((fact) => fact.taskId === input.task.taskId && fact.stepId === input.stepId)) return;
    const { agentId, phase } = input.task;
    const artifactRoot = scope.workflow.agentPaths(agentId).artifactRoot;
    const refs = resolveAgentArtifactReferences(input.outcome, {
      workflowId: workflow.workflowId, artifacts: [{ agentId, path: artifactRoot }],
    });
    const packPattern = phase === "execute"
      ? /^([^/]+)\/([^/]+)\/execute-pack\/?$/
      : /^([^/]+)\/([^/]+)\/review-pack(?:\/review-(?:result\.json|report\.html))?\/?$/;
    const candidates = new Map<string, { bddId: string; targetVersion: string }>();
    for (const ref of refs) {
      const local = relative(artifactRoot, ref.path).split(sep).join("/");
      const match = packPattern.exec(local);
      if (match) candidates.set(`${match[1]}/${match[2]}`, { bddId: match[1]!, targetVersion: match[2]! });
    }
    if (candidates.size !== 1) throw new Error("A formal RBT handoff must reference exactly one owned Pack.");
    const { bddId, targetVersion } = [...candidates.values()][0]!;
    const prefix = `${bddId}/${targetVersion}`;
    const submission = { bddId, targetVersion, taskId: input.task.taskId, stepId: input.stepId, submittedAt: input.submittedAt };
    if (phase === "execute") {
      const executePath = `${prefix}/execute-file.json`;
      if (!refs.some((ref) => ref.path === join(artifactRoot, executePath))) {
        throw new Error("Executor handoff must include its matching execute-file reference.");
      }
      const executeFile = this.artifact(agentId, executePath, "sha256");
      const pack = this.artifact(agentId, `${prefix}/execute-pack`, "scout-directory-sha256-v1");
      // These are submitted content identities, not a format-validity or execution-success claim.
      this.journal.recordExecutionPack({ ...submission, pack: { ...pack, executeFile } });
      return;
    }

    const reviewPath = `${prefix}/review-pack/review-result.json`;
    // The byte reader also enforces artifact containment before any JSON is consumed.
    this.artifact(agentId, reviewPath, "sha256");
    const value: unknown = JSON.parse(readFileSync(join(artifactRoot, reviewPath), "utf8"));
    if (!isRecord(value)) throw new Error("Review result must be an object.");
    const review = value;
    for (const key of ["bddId", "targetVersion", "campaignId", "executorHistoryRef", "summary"]) {
      const field = review[key];
      if (typeof field !== "string" || !field.trim()) throw new Error(`Review ${key} must be a non-empty string.`);
    }
    if (review.bddId !== bddId || review.targetVersion !== targetVersion) throw new Error("Review identity differs from its Pack location.");
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
    const histories = facts.histories.filter((history) => history.executorHistoryRef === review.executorHistoryRef);
    if (histories.length !== 1) throw new Error("Review must identify one recorded Executor history.");
    const history = histories[0]!;
    if (history.bddId !== bddId || history.targetVersion !== targetVersion || history.campaignId !== review.campaignId
      || (review.scenarioId !== undefined && history.scenarioId !== review.scenarioId)) throw new Error("Review does not match its execution history.");
    const executePath = `${prefix}/execute-file.json`;
    const historyPath = `history/${String(history.runtimeSequence).padStart(3, "0")}.json`;
    if (history.executeFileRef !== `scout-artifact://${workflow.workflowId}/${history.agentId}/${executePath}`
      || history.executorHistoryRef !== `scout-artifact://${workflow.workflowId}/${history.agentId}/${historyPath}`) throw new Error("Review execution references belong to a different Workflow or Agent.");
    const executorHistory = this.artifact(history.agentId, historyPath, "sha256");
    const executeFile = this.artifact(history.agentId, executePath, "sha256");
    if (executorHistory.digest !== history.executorHistoryDigest || executeFile.digest !== history.executeFileDigest) throw new Error("Reviewed execution evidence changed after execution.");
    const submitted = [...facts.executionPacks].reverse().find((fact) => fact.bddId === bddId && fact.targetVersion === targetVersion
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
    this.journal.recordReview({ ...submission, pack: { ...pack, result, executionPack: submitted.pack, execution } });
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

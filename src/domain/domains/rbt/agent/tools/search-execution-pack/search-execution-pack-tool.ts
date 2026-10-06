import { relative } from "node:path";
import { registerAgentPermissionRequestSource } from "../../../../../../core/authorization/request-source/permission/agent-permission-request-source.js";
import type { DynamicToolCallResponse } from "../../../../../../agent-server/types.js";
import type { AgentJsonValue } from "../../../../../../agent/tools/types.js";
import {
  formatArtifactReference, listFiles, listWorkflowArtifactPaths, readArtifactReference, readJsonFile,
  resolveArtifactTarget, resolveWorkflowLocation, type ScoutArtifactReference,
} from "../../../../../../core/io/index.js";
import { currentRunScope } from "../../../../../../run/run-scope.js";
import type { DomainAgentTool } from "../../../../../agent/domain-agent-backend.js";
import { ScoutDomainId, type ScoutDomainDynamicToolCall } from "../../../../../types.js";

/** Searches Benchmarks for a usable historical Pack and registers its read-access source, not its use. */
export class SearchExecutionPackTool implements DomainAgentTool {
  async execute(call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse> {
    const scope = currentRunScope();
    scope.workflow.requireActiveWorkflow();

    // Agent arguments are external Benchmark keys, not physical directory components.
    const input = call.input.arguments;
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => key !== "bdd_id" && key !== "target_version")) {
      throw new Error("SearchExecutionPack requires only bdd_id and target_version.");
    }
    const identity = (key: string): string => {
      const value: unknown = Reflect.get(input, key);
      if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
        throw new Error(`SearchExecutionPack ${key} must be a non-empty identity.`);
      }
      return value;
    };
    const bddId = identity("bdd_id");
    const targetVersion = identity("target_version");
    const respond = (output: AgentJsonValue): DynamicToolCallResponse => ({
      success: true, contentItems: [{ type: "inputText", text: JSON.stringify(output, null, 2) }],
    });
    const miss = (reason: string): DynamicToolCallResponse => respond({ status: "not_found", reason });

    // The last successful Review remains authoritative when a newer execution has not passed review.
    const history = scope.workflow.benchmarks.read(ScoutDomainId.Rbt, ["bddCatalog", bddId, targetVersion, "history"]);
    if (history === undefined) return miss("no_successful_workflow");
    if (!history || typeof history !== "object" || Array.isArray(history)) {
      throw new Error("RBT Benchmark history must be an object.");
    }
    const reference = history.lastReviewSuccess;
    if (reference === undefined) return miss("no_review_success");
    if (!reference || typeof reference !== "object" || Array.isArray(reference)
      || typeof reference.workflowId !== "string") {
      throw new Error("RBT Benchmark lastReviewSuccess must be a Workflow reference.");
    }
    const reviewId = reference.workflowId;
    if (!resolveWorkflowLocation(scope.runRoot, reviewId)) return miss("workflow_unavailable");

    // Physical Packs remain usable even when imported evidence has no execution links.
    const sources = new Map<string, ScoutArtifactReference>();
    for (const { agentId } of listWorkflowArtifactPaths(scope.runRoot, reviewId, "pack/execute-file.json")) {
      // Imported physical owner names are external identity data, not this Run's registered Agents.
      const source = readArtifactReference({ workflowId: reviewId, agentId, internalSymbols: ["pack", "execute-file.json"] });
      sources.set(formatArtifactReference(source), source);
    }
    const readExecutionSource = (path: string): ScoutArtifactReference => {
      const value = readJsonFile<unknown>(path);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("RBT execution artifact must be an object.");
      }
      const source = readArtifactReference("executeFileRef" in value ? value.executeFileRef : undefined);
      if (source.internalSymbols.join("/") !== "pack/execute-file.json") {
        throw new Error("RBT execution artifact must reference pack/execute-file.json.");
      }
      return source;
    };
    if (sources.size === 0) {
      // These file links only locate a Pack used elsewhere; statuses and digests do not qualify it.
      for (const { path } of listWorkflowArtifactPaths(scope.runRoot, reviewId, "history")) {
        for (const file of listFiles(path)) {
          if (!/^\d+\.json$/.test(relative(path, file))) continue;
          const source = readExecutionSource(file);
          sources.set(formatArtifactReference(source), source);
        }
      }
    }
    let candidates: ScoutArtifactReference[] = [];
    for (const source of sources.values()) {
      const target = resolveArtifactTarget(source);
      if (!("reason" in target)) candidates.push({ ...source, internalSymbols: ["pack"] });
    }
    // A Review link identifies the actual delivered execution, even if a trial Pack remains locally.
    // Read only location links; neither the verdict nor historical status/digest qualifies the Pack.
    const deliveredSources = new Map<string, ScoutArtifactReference>();
    const reviewDeliveries = listWorkflowArtifactPaths(scope.runRoot, reviewId, "pack/review-result.json");
    for (const { path } of reviewDeliveries) {
      const value = readJsonFile<unknown>(path);
      if (!value || typeof value !== "object" || Array.isArray(value) || !("executorHistoryRef" in value)) {
        throw new Error("RBT Review delivery must identify its Executor history.");
      }
      const historyRef = readArtifactReference(value.executorHistoryRef);
      if (!/^history\/\d+\.json$/.test(historyRef.internalSymbols.join("/"))) {
        throw new Error("RBT Review delivery must reference an Executor history file.");
      }
      // Imported local evidence keeps its original link; the selected identity owns that file now.
      const target = resolveArtifactTarget({ ...historyRef, workflowId: reviewId });
      if ("reason" in target) continue;
      const source = readExecutionSource(target.path);
      // Local Pack references move with a reidentified import; external Pack references retain ownership.
      const reference = { ...source, workflowId: source.workflowId === historyRef.workflowId ? reviewId : source.workflowId,
        internalSymbols: ["pack"] };
      deliveredSources.set(formatArtifactReference(reference), reference);
    }
    if (reviewDeliveries.length) {
      candidates = [];
      for (const reference of deliveredSources.values()) {
        const target = resolveArtifactTarget({ ...reference, internalSymbols: ["pack", "execute-file.json"] });
        if (!("reason" in target)) candidates.push(reference);
      }
    }
    if (!candidates.length) return miss("pack_unavailable");
    if (candidates.length > 1) throw new Error(`Ambiguous RBT Execution Pack in ${reviewId}: ${candidates.map((reference) => `${reference.workflowId}/${reference.agentId}`).join(", ")}.`);
    const candidate = candidates[0]!;

    const allowedConsumers = scope.workflow.graph.snapshot().roles.flatMap((role) => {
      const phases = role.phases.filter((phase) => phase === "execute" || phase === "review");
      return phases.length ? [{ agentId: role.name, phases }] : [];
    });
    await registerAgentPermissionRequestSource(call.input, {
      sourceKey: formatArtifactReference(candidate),
      target: candidate,
      allowedConsumers,
      maxApprovals: allowedConsumers.length,
    });
    return respond({ status: "found", "execute-pack-ref": {
      ...candidate, internalSymbols: [...candidate.internalSymbols],
    } });
  }
}

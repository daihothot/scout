import { relative } from "node:path";
import { registerAgentPermissionRequestSource } from "../../../../../../core/authorization/request-source/permission/agent-permission-request-source.js";
import type { DynamicToolCallResponse } from "../../../../../../agent-server/types.js";
import type { AgentJsonValue } from "../../../../../../agent/tools/types.js";
import {
  formatArtifactReference, listFiles, listWorkflowArtifactPaths, readArtifactReference, readJsonFile,
  resolveArtifactTarget, resolveWorkflowLocation, shellToolWrapperPath, type ScoutArtifactReference,
} from "../../../../../../core/io/index.js";
import { HostCommandExecutor } from "../../../../../../host/host-command-executor.js";
import { currentRunScope } from "../../../../../../run/run-scope.js";
import type { DomainAgentTool } from "../../../../../agent/domain-agent-backend.js";
import { ScoutDomainId, type ScoutDomainDynamicToolCall } from "../../../../../types.js";

/** Searches Benchmarks for a usable historical Pack and registers its read-access source, not its use. */
export class SearchExecutionPackTool implements DomainAgentTool {
  constructor(private readonly commands = new HostCommandExecutor()) {}

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
    const miss = (reason: string, detail?: string): DynamicToolCallResponse => respond({
      status: "not_found", reason, ...(detail ? { detail } : {}),
    });

    // The manually editable Benchmarks are the authority for execution/review success.
    const history = scope.workflow.benchmarks.read(ScoutDomainId.Rbt, ["bddCatalog", bddId, targetVersion, "history"]);
    if (history === undefined) return miss("no_successful_workflow");
    if (!history || typeof history !== "object" || Array.isArray(history)) {
      throw new Error("RBT Benchmark history must be an object.");
    }
    const [executionId, reviewId] = ["lastExecutionSuccess", "lastReviewSuccess"].map((field) => {
      const reference = history[field];
      if (reference === undefined) return undefined;
      if (!reference || typeof reference !== "object" || Array.isArray(reference)
        || typeof reference.workflowId !== "string") {
        throw new Error(`RBT Benchmark ${field} must be a Workflow reference.`);
      }
      return reference.workflowId;
    });
    if (!executionId || !reviewId) return miss("execution_or_review_not_successful");
    if (executionId !== reviewId) return miss("success_workflows_differ");
    if (!resolveWorkflowLocation(scope.runRoot, executionId)) return miss("workflow_unavailable");

    // Physical Packs remain usable even when imported evidence has no execution links.
    const sources = new Map<string, ScoutArtifactReference>();
    for (const { agentId } of listWorkflowArtifactPaths(scope.runRoot, executionId, "pack/execute-file.json")) {
      // Imported physical owner names are external identity data, not this Run's registered Agents.
      const source = readArtifactReference({ workflowId: executionId, agentId, internalSymbols: ["pack", "execute-file.json"] });
      sources.set(formatArtifactReference(source), source);
    }
    const readExecutionSource = (path: string): ScoutArtifactReference | undefined => {
      const value = readJsonFile<unknown>(path);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("RBT execution artifact must be an object.");
      }
      if (!("bddId" in value) || value.bddId !== bddId || !("targetVersion" in value) || value.targetVersion !== targetVersion) return undefined;
      const source = readArtifactReference("executeFileRef" in value ? value.executeFileRef : undefined);
      if (source.internalSymbols.join("/") !== "pack/execute-file.json") {
        throw new Error("RBT execution artifact must reference pack/execute-file.json.");
      }
      return source;
    };
    if (sources.size === 0) {
      // These file links only locate a Pack used elsewhere; statuses and digests do not qualify it.
      for (const { path } of listWorkflowArtifactPaths(scope.runRoot, executionId, "history")) {
        for (const file of listFiles(path)) {
          if (!/^\d+\.json$/.test(relative(path, file))) continue;
          const source = readExecutionSource(file);
          if (source) sources.set(formatArtifactReference(source), source);
        }
      }
    }
    let candidates: { reference: ScoutArtifactReference; path: string }[] = [];
    for (const source of sources.values()) {
      const reference = { ...source, internalSymbols: ["pack"] };
      const target = resolveArtifactTarget(reference);
      if (!("reason" in target)) candidates.push({ reference, path: target.path });
    }
    // A Review link identifies the actual delivered execution, even if a trial Pack remains locally.
    // Read only location links; neither the verdict nor historical status/digest qualifies the Pack.
    const deliveredSources = new Map<string, ScoutArtifactReference>();
    for (const { path } of listWorkflowArtifactPaths(scope.runRoot, executionId, "pack/review-result.json")) {
      const value = readJsonFile<unknown>(path);
      if (!value || typeof value !== "object" || Array.isArray(value) || !("executorHistoryRef" in value)) {
        throw new Error("RBT Review delivery must identify its Executor history.");
      }
      const historyRef = readArtifactReference(value.executorHistoryRef);
      if (!/^history\/\d+\.json$/.test(historyRef.internalSymbols.join("/"))) {
        throw new Error("RBT Review delivery must reference an Executor history file.");
      }
      // Imported local evidence keeps its original link; the selected identity owns that file now.
      const target = resolveArtifactTarget({ ...historyRef, workflowId: executionId });
      if ("reason" in target) continue;
      const source = readExecutionSource(target.path);
      if (!source) continue;
      // Local Pack references move with a reidentified import; external Pack references retain ownership.
      const reference = { ...source, workflowId: source.workflowId === historyRef.workflowId ? executionId : source.workflowId,
        internalSymbols: ["pack"] };
      deliveredSources.set(formatArtifactReference(reference), reference);
    }
    if (deliveredSources.size) {
      candidates = [];
      for (const reference of deliveredSources.values()) {
        const target = resolveArtifactTarget(reference);
        if (!("reason" in target)) candidates.push({ reference, path: target.path });
      }
    }
    if (!candidates.length) return miss("pack_unavailable");
    if (candidates.length > 1) throw new Error(`Ambiguous RBT Execution Pack in ${executionId}: ${candidates.map(({ reference }) => `${reference.workflowId}/${reference.agentId}`).join(", ")}.`);
    const candidate = candidates[0]!;

    const caller = scope.agentRegistry.resolveToolCaller(call.input.threadId);
    if (!caller) throw new Error(`Unknown Pack search caller: ${call.input.threadId}`);
    const checker = caller.mount.shellTools.find((tool) => tool.id === "scoutRbtArtifactCheck");
    if (!checker) throw new Error("SearchExecutionPack requires the mounted scoutRbtArtifactCheck tool.");
    const checked = await this.commands.run({
      executable: shellToolWrapperPath(caller.mount.mountRoot, checker.exposeAs),
      args: ["pack", candidate.path, "--bdd-id", bddId, "--target-version", targetVersion],
      cwd: caller.spec.cwd,
      timeoutMs: 30_000,
    });
    if (checked.status !== "completed") {
      if (checked.status === "failed" && checked.exitCode === 1) return miss("pack_invalid", checked.stderr.trim());
      throw new Error(`RBT Pack checker failed: ${checked.error || checked.stderr.trim() || checked.status}`);
    }

    const allowedConsumers = scope.workflow.graph.snapshot().roles.flatMap((role) => {
      const phases = role.phases.filter((phase) => phase === "execute" || phase === "review");
      return phases.length ? [{ agentId: role.name, phases }] : [];
    });
    await registerAgentPermissionRequestSource(call.input, {
      sourceKey: formatArtifactReference(candidate.reference),
      target: candidate.reference,
      allowedConsumers,
      maxApprovals: allowedConsumers.length,
    });
    return respond({ status: "found", "execute-pack-ref": {
      ...candidate.reference, internalSymbols: [...candidate.reference.internalSymbols],
    } });
  }
}

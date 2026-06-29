import { join } from "node:path";
import type {
  AssetCommit,
  CodexMount,
} from "../../asset-store/index.js";
import type { ScoutAgentRole } from "../../agent/types.js";
import { ScoutAgentRoles } from "../../agent/types.js";
import { CoordinatorAgent } from "../../agent/roles/coordinator-agent.js";
import { AgentBackend } from "../../agent/backend/agent-backend.js";
import { ScoutAgentOrchestrator } from "../../agent/orchestration/scout-agent-orchestrator.js";
import { Logger } from "../../core/logging/index.js";
import { loadScoutInput } from "../../input/index.js";
import { NoopRuntimeInteractionPort } from "../../interaction/index.js";
import { prepareRuntimeRun, type PreparedRuntimeRun } from "./run-preparation.js";
import type { CreateCodexAppServerClientOptions } from "../../agent-server/codex/app-server-factory.js";
import { buildRuntimeContextBundle } from "../types.js";
import type { ScoutRunOptions, ScoutRunResult } from "./run-types.js";

export class RunManager {
  async prepareRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
    const input = this.loadRequiredInput(options);
    const preparedRun = await prepareRuntimeRun<CreateCodexAppServerClientOptions>({
      repoRoot: options.cwd,
      runId: buildRunId(),
      mcpServerBindings: options.mcpServerBindings,
      createAppServerClient: (clientOptions) => clientOptions,
    });
    return this.toRunResult(preparedRun, input.scoutInputPath);
  }

  async startRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
    const interactionPort = options.interactionPort ?? new NoopRuntimeInteractionPort();
    const input = this.loadRequiredInput(options);
    await interactionPort.disclose({
      level: "info",
      source: "run.manager",
      message: "Preparing Scout run.",
      data: {
        scoutInputPath: input.scoutInputPath,
      },
    });

    const preparedRun = await prepareRuntimeRun({
      repoRoot: options.cwd,
      runId: buildRunId(),
      mcpServerBindings: options.mcpServerBindings,
    });
    const preparationStatus = runPreparationStatus(preparedRun);
    if (preparationStatus !== "passed") {
      await interactionPort.disclose({
        level: "error",
        source: "run.manager",
        message: "Scout run preparation failed.",
        data: {
          runId: preparedRun.runId,
          agents: summarizeAgents(preparedRun),
        },
      });
      preparedRun.appServerClient.client.close();
      return this.toRunResult(preparedRun, input.scoutInputPath, "failed");
    }

    const coordinator = preparedRun.agents[ScoutAgentRoles.Coordinator];
    const contextBundle = buildRuntimeContextBundle({
      runId: preparedRun.runId,
      assetCommit: coordinator.assetCommit,
      scoutInputRef: input.scoutInputPath,
      scoutInput: input.scoutInput,
    });
    const runtimeLogger = new Logger({
      runId: preparedRun.runId,
      logsRoot: join(coordinator.assetCommit.runRoot, "logs"),
    });
    const appServer = preparedRun.appServerClient.client;
    const agentMounts = mapPreparedAgents(preparedRun, (agent) => agent.mount);
    const agentAssetCommits = mapPreparedAgents(preparedRun, (agent) => agent.assetCommit);
    const agentOptions = {
      repoRoot: options.cwd,
      appServer,
      contextBundle,
      agentMount: coordinator.mount,
      assetCommit: coordinator.assetCommit,
      logger: runtimeLogger,
    };
    const agentBackend = new AgentBackend({
      runId: preparedRun.runId,
      ledgerRoot: coordinator.mount.artifactRoot,
      interactionPort,
      agentMounts,
      agentAssetCommits,
      ...agentOptions,
    });
    const coordinatorAgent = new CoordinatorAgent({
      ...agentOptions,
      agentBackend,
    });

    let orchestrationStatus: ScoutRunResult["orchestrationStatus"] = "failed";
    try {
      await appServer.startSession();
      const { thread: coordinatorThread } = await coordinatorAgent.startWithPreflight();
      const orchestrator = new ScoutAgentOrchestrator({
        coordinator: coordinatorAgent,
        agentBackend,
        coordinatorThread,
        interactionPort,
        initialPrompt: coordinatorAgent.buildInitialPrompt({
          runId: preparedRun.runId,
          contextBundleId: contextBundle.contextBundleId,
          scoutInputRef: input.scoutInputPath,
          mountRoot: coordinator.mount.mountRoot,
        }),
      });
      const loopResult = await orchestrator.run();
      orchestrationStatus = loopResult.status;
    } finally {
      appServer.close();
    }

    return {
      ...this.toRunResult(preparedRun, input.scoutInputPath, "passed"),
      orchestrationStatus,
      agentLedgerPath: join(coordinator.mount.artifactRoot, "agent-ledger.json"),
    };
  }

  private loadRequiredInput(options: ScoutRunOptions): {
    scoutInputPath: string;
    scoutInput: ReturnType<typeof loadScoutInput>;
  } {
    if (!options.scoutInputPath) {
      throw new Error("Scout run requires --scout-input <path-to-scout-input.json>.");
    }
    return {
      scoutInputPath: options.scoutInputPath,
      scoutInput: loadScoutInput(options.scoutInputPath),
    };
  }

  private toRunResult(
    preparedRun: PreparedRuntimeRun<unknown>,
    scoutInputPath: string,
    forcedStatus?: ScoutRunResult["status"],
  ): ScoutRunResult {
    const coordinator = preparedRun.agents[ScoutAgentRoles.Coordinator];
    return {
      status: forcedStatus ?? runPreparationStatus(preparedRun),
      runId: preparedRun.runId,
      coordinatorMountRoot: coordinator.mount.mountRoot,
      mcpServerBindings: coordinator.mount.mcpServerBindings,
      rootAccess: preparedRun.rootAccess,
      agents: mapPreparedAgents(preparedRun, (agent) => ({
        mountId: agent.mount.mountId,
        mountRoot: agent.mount.mountRoot,
        artifactRoot: agent.mount.artifactRoot,
        assetCommitId: agent.assetCommit.assetCommitId,
        assetCommitPath: agent.assetCommitPath,
        preflightStatus: agent.preflight.status,
        preflightPath: agent.preflightPath,
      })),
      scoutInputPath,
    };
  }
}

export async function prepareRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
  return new RunManager().prepareRun(options);
}

export async function startRun(options: ScoutRunOptions): Promise<ScoutRunResult> {
  return new RunManager().startRun(options);
}

function runPreparationStatus(preparedRun: PreparedRuntimeRun<unknown>): ScoutRunResult["status"] {
  return Object.values(preparedRun.agents).every((agent) => agent.assetCommit.status === "preflight_passed")
    ? "passed"
    : "failed";
}

function summarizeAgents(preparedRun: PreparedRuntimeRun<unknown>): Record<string, unknown> {
  return mapPreparedAgents(preparedRun, (agent) => ({
    preflightStatus: agent.preflight.status,
    assetCommitStatus: agent.assetCommit.status,
    issueCount: agent.mount.issues.length,
  }));
}

function mapPreparedAgents<T>(
  preparedRun: PreparedRuntimeRun<unknown>,
  mapper: (agent: PreparedRuntimeRun<unknown>["agents"][ScoutAgentRole]) => T,
): Record<ScoutAgentRole, T> {
  return Object.fromEntries(
    Object.entries(preparedRun.agents).map(([role, agent]) => [
      role,
      mapper(agent),
    ]),
  ) as Record<ScoutAgentRole, T>;
}

function buildRunId(): string {
  return `run-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
}

import { join, relative } from "node:path";
import {
  preflightCodexAppServerMount,
  summarizeAgentServerPreflight,
} from "../../../agent-server/codex/app-server-preflight.js";
import type { AgentServerPreflightReport } from "../../../agent-server/types.js";
import {
  AssetStore,
  type CodexMount,
} from "../../../asset-store/index.js";
import type {
  ScoutAgentRole,
} from "../../../agent/thread/types.js";
import { ScoutAgentRoles } from "../../../agent/thread/types.js";
import { writeJsonFile } from "../../../core/fs.js";
import { currentRunScope } from "../../run-scope.js";
import {
  buildRunContextBundle,
  type RunAgentEnvironment,
} from "../../types.js";
import { buildRunRootAccess } from "../../root-access.js";
import type { RunRootAccess } from "../../types.js";
import type { RunAgentManifestEntry } from "../../persistence/index.js";
import type { RunStage } from "../../lifecycle/run-stage.js";

export interface PrepareEnvironmentStageOptions {
  agentRoles?: readonly ScoutAgentRole[];
  assetStore?: AssetStore;
  preflightMount?(mount: CodexMount): Promise<AgentServerPreflightReport>;
}

export class PrepareEnvironmentStage implements RunStage {
  readonly id = "environment";
  private readonly options: PrepareEnvironmentStageOptions;
  private preparedAgents?: Record<ScoutAgentRole, RunAgentEnvironment>;
  private preparedRootAccess?: RunRootAccess;

  constructor(options: PrepareEnvironmentStageOptions = {}) {
    this.options = options;
  }

  get repoRoot(): string {
    return currentRunScope().repoRoot;
  }

  get runId(): string {
    return currentRunScope().runId;
  }

  get prepared(): boolean {
    return Boolean(this.preparedAgents && this.preparedRootAccess);
  }

  get agents(): Record<ScoutAgentRole, RunAgentEnvironment> {
    if (!this.preparedAgents) throw new Error("Prepare environment stage has not completed.");
    return this.preparedAgents;
  }

  get rootAccess(): RunRootAccess {
    if (!this.preparedRootAccess) throw new Error("Prepare environment stage has not completed.");
    return this.preparedRootAccess;
  }

  async start(): Promise<void> {
    const scope = currentRunScope();
    const assetStore = this.options.assetStore ?? new AssetStore();
    const preflightMount = this.options.preflightMount ?? ((mount) =>
      preflightCodexAppServerMount({
        mount,
        appServer: currentRunScope().appServer,
      })
    );
    const agentRoles = this.options.agentRoles ?? Object.values(ScoutAgentRoles);
    const agents: Partial<Record<ScoutAgentRole, RunAgentEnvironment>> = {};

    for (const role of agentRoles) {
      const mount = assetStore.materializeMount({
        repoRoot: scope.repoRoot,
        runId: scope.runId,
        agentId: role,
      });
      const preflight = await preflightMount(mount);
      const preflightPath = join(mount.artifactRoot, "app-server-preflight.json");
      writeJsonFile(preflightPath, summarizeAgentServerPreflight(preflight, mount));

      const preflightStatus = mount.issues.some((issue) => issue.severity === "error")
        ? "failed"
        : preflight.status;
      const assetCommit = assetStore.buildCommit({
        mount,
        preflightStatus,
        preflightPath,
      });
      const assetCommitPath = join(mount.artifactRoot, "asset-commit.json");
      writeJsonFile(assetCommitPath, assetCommit);

      agents[role] = {
        role,
        mount,
        preflight,
        preflightPath,
        assetCommit,
        assetCommitPath,
      };
    }

    this.preparedAgents = requirePreparedAgents(agents, agentRoles);
    this.preparedRootAccess = buildRunRootAccess(assetStore, this.preparedAgents);
    const environment = {
      agents: this.preparedAgents,
      rootAccess: this.preparedRootAccess,
      contextBundle: buildRunContextBundle({
        runId: scope.runId,
        assetCommit: this.preparedAgents[ScoutAgentRoles.Coordinator].assetCommit,
      }),
    };
    scope.setEnvironment(environment);
    const runRoot = join(scope.repoRoot, "run", scope.runId);
    const toManifestEntry = (agent: RunAgentEnvironment): RunAgentManifestEntry => ({
      mountId: agent.mount.mountId,
      assetCommitId: agent.assetCommit.assetCommitId,
      resourceHash: agent.assetCommit.resourceHash,
      mountManifestRef: relative(runRoot, agent.mount.manifestPath),
      assetCommitRef: relative(runRoot, agent.assetCommitPath),
      preflightRef: relative(runRoot, agent.preflightPath),
    });
    scope.manifestStore.update((manifest) => ({
      ...manifest,
      agents: {
        [ScoutAgentRoles.Coordinator]: toManifestEntry(
          environment.agents[ScoutAgentRoles.Coordinator],
        ),
        [ScoutAgentRoles.Researcher]: toManifestEntry(
          environment.agents[ScoutAgentRoles.Researcher],
        ),
        [ScoutAgentRoles.Verifier]: toManifestEntry(
          environment.agents[ScoutAgentRoles.Verifier],
        ),
        [ScoutAgentRoles.Validator]: toManifestEntry(
          environment.agents[ScoutAgentRoles.Validator],
        ),
      },
      checkpointSeq: scope.journal.lastSeq,
    }));
    if (!Object.values(this.preparedAgents).every((agent) =>
      agent.assetCommit.status === "preflight_passed"
    )) {
      throw new Error("Scout run preflight failed.");
    }
  }
}

function requirePreparedAgents(
  agents: Partial<Record<ScoutAgentRole, RunAgentEnvironment>>,
  roles: readonly ScoutAgentRole[],
): Record<ScoutAgentRole, RunAgentEnvironment> {
  const result: Partial<Record<ScoutAgentRole, RunAgentEnvironment>> = {};
  for (const role of roles) {
    const agent = agents[role];
    if (!agent) throw new Error(`Prepared environment did not produce agent runtime: ${role}`);
    result[role] = agent;
  }
  return result as Record<ScoutAgentRole, RunAgentEnvironment>;
}

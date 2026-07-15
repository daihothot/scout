import { join, resolve } from "node:path";
import type { CodexAppServerClient } from "../../../agent-server/codex/app-server-client.js";
import { preflightCodexAppServerMount } from "../../../agent-server/codex/app-server-preflight.js";
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
  type RunRootAccess,
} from "../../types.js";
import type { BootStage } from "../boot-stage.js";

export interface BootEnvironmentStageOptions {
  agentRoles?: readonly ScoutAgentRole[];
  assetStore?: AssetStore;
  preflightMount?(input: {
    mount: CodexMount;
    appServer: CodexAppServerClient;
  }): Promise<AgentServerPreflightReport>;
}

export class BootEnvironmentStage implements BootStage {
  readonly id = "environment";
  private readonly options: BootEnvironmentStageOptions;
  private bootAgents?: Record<ScoutAgentRole, RunAgentEnvironment>;
  private bootRootAccess?: RunRootAccess;

  constructor(options: BootEnvironmentStageOptions = {}) {
    this.options = options;
  }

  get repoRoot(): string {
    return currentRunScope().repoRoot;
  }

  get runId(): string {
    return currentRunScope().runId;
  }

  get prepared(): boolean {
    return Boolean(this.bootAgents && this.bootRootAccess);
  }

  get agents(): Record<ScoutAgentRole, RunAgentEnvironment> {
    if (!this.bootAgents) throw new Error("Boot environment stage has not completed.");
    return this.bootAgents;
  }

  get rootAccess(): RunRootAccess {
    if (!this.bootRootAccess) throw new Error("Boot environment stage has not completed.");
    return this.bootRootAccess;
  }

  async start(): Promise<void> {
    const scope = currentRunScope();
    const assetStore = this.options.assetStore ?? new AssetStore();
    const preflightMount = this.options.preflightMount ?? ((input) =>
      preflightCodexAppServerMount({
        mount: input.mount,
        appServer: input.appServer,
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
      const preflight = await preflightMount({
        mount,
        appServer: scope.appServer,
      });
      const preflightPath = join(mount.artifactRoot, "app-server-preflight.json");
      writeJsonFile(preflightPath, preflight);

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

    this.bootAgents = requireBootAgents(agents, agentRoles);
    this.bootRootAccess = collectRunRootAccess(assetStore, this.bootAgents);
    scope.setEnvironment({
      agents: this.bootAgents,
      rootAccess: this.bootRootAccess,
      contextBundle: buildRunContextBundle({
        runId: scope.runId,
        assetCommit: this.bootAgents[ScoutAgentRoles.Coordinator].assetCommit,
      }),
    });
    if (!Object.values(this.bootAgents).every((agent) =>
      agent.assetCommit.status === "preflight_passed"
    )) {
      throw new Error("Scout run preflight failed.");
    }
  }
}

function collectRunRootAccess(
  assetStore: AssetStore,
  agents: Record<ScoutAgentRole, RunAgentEnvironment>,
): RunRootAccess {
  const bootAgents = Object.values(agents);
  return {
    mountRoots: uniqueResolved(bootAgents.map((agent) => agent.mount.mountRoot)),
    trustedRoots: uniqueResolved(bootAgents.flatMap((agent) =>
      assetStore.trustedRootsForMount(agent.mount)
    )),
    writableRoots: uniqueResolved(bootAgents.flatMap((agent) =>
      assetStore.writableRootsForMount(agent.mount)
    )),
  };
}

function requireBootAgents(
  agents: Partial<Record<ScoutAgentRole, RunAgentEnvironment>>,
  roles: readonly ScoutAgentRole[],
): Record<ScoutAgentRole, RunAgentEnvironment> {
  const result: Partial<Record<ScoutAgentRole, RunAgentEnvironment>> = {};
  for (const role of roles) {
    const agent = agents[role];
    if (!agent) throw new Error(`Boot environment did not produce agent runtime: ${role}`);
    result[role] = agent;
  }
  return result as Record<ScoutAgentRole, RunAgentEnvironment>;
}

function uniqueResolved(values: string[]): string[] {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

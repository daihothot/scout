import { join, resolve } from "node:path";
import {
  createCodexAppServerClient,
  type CodexAppServerClientBundle,
  type CreateCodexAppServerClientOptions,
} from "../../agent-server/codex/app-server-factory.js";
import { preflightCodexMount } from "../../agent-server/codex/mount-preflight.js";
import type { AgentServerPreflightResult } from "../../agent-server/types.js";
import {
  AssetStore,
  type AssetCommit,
  type CodexMount,
} from "../../asset-store/index.js";
import { writeJsonFile } from "../../core/fs.js";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../agent/types.js";

export const RuntimeRunAgentRoles = [
  ScoutAgentRoles.Coordinator,
  ScoutAgentRoles.Researcher,
  ScoutAgentRoles.Verifier,
  ScoutAgentRoles.Validator,
] as const;

export interface PreparedAgentRuntime {
  role: ScoutAgentRole;
  mount: CodexMount;
  preflight: AgentServerPreflightResult;
  preflightPath: string;
  assetCommit: AssetCommit;
  assetCommitPath: string;
}

export interface RuntimeRunRootAccess {
  mountRoots: string[];
  trustedRoots: string[];
  writableRoots: string[];
}

export interface PreparedRuntimeRun<TClientBundle = CodexAppServerClientBundle> {
  runId: string;
  repoRoot: string;
  agents: Record<ScoutAgentRole, PreparedAgentRuntime>;
  rootAccess: RuntimeRunRootAccess;
  appServerClient: TClientBundle;
}

export interface PrepareRuntimeRunOptions<TClientBundle = CodexAppServerClientBundle> {
  repoRoot: string;
  runId: string;
  mcpServerBindings?: Record<string, Record<string, string>>;
  agentRoles?: readonly ScoutAgentRole[];
  assetStore?: AssetStore;
  preflightMount?: (mount: CodexMount) => Promise<AgentServerPreflightResult>;
  createAppServerClient?: (options: CreateCodexAppServerClientOptions) => TClientBundle;
}

export async function prepareRuntimeRun<TClientBundle = CodexAppServerClientBundle>(
  options: PrepareRuntimeRunOptions<TClientBundle>,
): Promise<PreparedRuntimeRun<TClientBundle>> {
  const assetStore = options.assetStore ?? new AssetStore();
  const preflightMount = options.preflightMount ?? preflightCodexMount;
  const agentRoles = options.agentRoles ?? RuntimeRunAgentRoles;
  const agents: Partial<Record<ScoutAgentRole, PreparedAgentRuntime>> = {};

  for (const role of agentRoles) {
    const mount = assetStore.materializeMount({
      repoRoot: options.repoRoot,
      runId: options.runId,
      agentId: role,
      mcpServerBindings: options.mcpServerBindings,
    });
    const preflight = await preflightMount(mount);
    const preflightPath = join(mount.artifactRoot, "mount-preflight.json");
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

  const preparedAgents = requirePreparedAgents(agents, agentRoles);
  const rootAccess = collectRunRootAccess(assetStore, preparedAgents);
  let appServerClient: TClientBundle;
  const createClientOptions = {
    mountRoots: rootAccess.mountRoots,
    trustedRoots: rootAccess.trustedRoots,
    writableRoots: rootAccess.writableRoots,
    tempPrefix: `${options.runId}-codex-home-`,
    logPrefix: `scout ${options.runId} app-server`,
  };
  if (options.createAppServerClient) {
    appServerClient = options.createAppServerClient(createClientOptions);
  } else {
    appServerClient = createCodexAppServerClient(createClientOptions) as TClientBundle;
  }

  return {
    runId: options.runId,
    repoRoot: options.repoRoot,
    agents: preparedAgents,
    rootAccess,
    appServerClient,
  };
}

function collectRunRootAccess(
  assetStore: AssetStore,
  agents: Record<ScoutAgentRole, PreparedAgentRuntime>,
): RuntimeRunRootAccess {
  const preparedAgents = Object.values(agents);
  return {
    mountRoots: uniqueResolved(preparedAgents.map((agent) => agent.mount.mountRoot)),
    trustedRoots: uniqueResolved(preparedAgents.flatMap((agent) =>
      assetStore.trustedRootsForMount(agent.mount)
    )),
    writableRoots: uniqueResolved(preparedAgents.flatMap((agent) =>
      assetStore.writableRootsForMount(agent.mount)
    )),
  };
}

function requirePreparedAgents(
  agents: Partial<Record<ScoutAgentRole, PreparedAgentRuntime>>,
  roles: readonly ScoutAgentRole[],
): Record<ScoutAgentRole, PreparedAgentRuntime> {
  const result: Partial<Record<ScoutAgentRole, PreparedAgentRuntime>> = {};
  for (const role of roles) {
    const agent = agents[role];
    if (!agent) {
      throw new Error(`Runtime run preparation did not produce agent runtime: ${role}`);
    }
    result[role] = agent;
  }
  return result as Record<ScoutAgentRole, PreparedAgentRuntime>;
}

function uniqueResolved(values: string[]): string[] {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

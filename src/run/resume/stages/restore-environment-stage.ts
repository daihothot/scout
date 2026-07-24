import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { AgentServerPreflightReport } from "../../../agent-server/types.js";
import {
  AssetStore,
  type AssetCommit,
  type CodexMount,
  type MountManifest,
} from "../../../asset-store/index.js";
import {
  type ScoutAgentRole,
  ScoutAgentRoles,
} from "../../../agent/thread/types.js";
import {
  hashDirectory,
  readJsonFile,
  sha256File,
} from "../../../core/fs.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../../lifecycle/index.js";
import {
  buildRunContextBundle,
  type RunAgentEnvironment,
  type RunRootAccess,
} from "../../types.js";

export class RestoreEnvironmentStage implements RunStage {
  readonly id = "restore_environment";

  async start(): Promise<void> {
    const scope = currentRunScope();
    const manifest = scope.manifestStore.read();
    const manifestAgents = manifest.agents;
    if (!manifestAgents) throw new Error(`Run ${manifest.runId} has no persisted agent index.`);
    if (resolve(manifest.repoRoot) !== resolve(scope.repoRoot)) {
      throw new Error(`Run ${manifest.runId} belongs to ${manifest.repoRoot}, not ${scope.repoRoot}.`);
    }

    const runRoot = resolve(scope.repoRoot, "run", scope.runId);
    const restoredAgents: Partial<Record<ScoutAgentRole, RunAgentEnvironment>> = {};
    for (const role of Object.values(ScoutAgentRoles)) {
      const entry = manifestAgents[role];
      if (!entry) throw new Error(`Run ${manifest.runId} has no persisted index for ${role}.`);
      const mountManifestPath = resolveRunRef(runRoot, entry.mountManifestRef, "mount manifest");
      const assetCommitPath = resolveRunRef(runRoot, entry.assetCommitRef, "asset commit");
      const preflightPath = resolveRunRef(runRoot, entry.preflightRef, "preflight report");
      requirePath(mountManifestPath, "mount manifest");
      requirePath(assetCommitPath, "asset commit");
      requirePath(preflightPath, "preflight report");
      const mountManifest = readJsonFile<MountManifest>(mountManifestPath);
      const assetCommit = readJsonFile<AssetCommit>(assetCommitPath);
      const preflight = readJsonFile<AgentServerPreflightReport>(preflightPath);
      if (assetCommit.status !== "preflight_passed" || preflight.status !== "passed") {
        throw new Error(`Run environment for ${role} did not pass preflight.`);
      }
      if (
        mountManifest.agentId !== role
        || assetCommit.agentId !== role
        || mountManifest.mountId !== entry.mountId
        || assetCommit.mountId !== entry.mountId
        || mountManifest.assetCommitId !== entry.assetCommitId
        || assetCommit.assetCommitId !== entry.assetCommitId
        || mountManifest.resourceHash !== entry.resourceHash
        || assetCommit.resourceHash !== entry.resourceHash
      ) {
        throw new Error(`Persisted mount identity does not match run index for ${role}.`);
      }
      if (
        resolve(assetCommit.manifestPath) !== mountManifestPath
        || !assetCommit.preflightRef
        || resolve(assetCommit.preflightRef) !== preflightPath
        || resolve(assetCommit.mountRoot) !== resolve(
          dirname(mountManifestPath),
          mountManifest.mountRoot,
        )
      ) {
        throw new Error(`Persisted artifact references do not match for ${role}.`);
      }
      const mount = buildMount(assetCommit);
      assertInsideRun(runRoot, mount.mountRoot);
      requirePath(mount.mountRoot, "mount root");
      for (const asset of mountManifest.assets) {
        const sourcePath = resolve(scope.repoRoot, asset.sourcePath);
        assertInsideRoot(resolve(scope.repoRoot), sourcePath, "asset source");
        requirePath(sourcePath, `asset source ${asset.id}`);
        const actualHash = asset.type === "plugin"
          ? hashDirectory(sourcePath)
          : sha256File(sourcePath);
        if (actualHash !== asset.hash) {
          throw new Error(`Persisted asset changed for ${role}: ${asset.sourcePath}`);
        }
      }
      for (const file of [...mountManifest.linkedFiles, ...mountManifest.generatedFiles]) {
        const mountedPath = resolve(mount.mountRoot, file.path);
        assertInsideRoot(resolve(mount.mountRoot), mountedPath, "mounted file");
        requirePath(mountedPath, `mounted file ${file.path}`);
        if (sha256File(mountedPath) !== file.hash) {
          throw new Error(`Persisted mount file changed for ${role}: ${file.path}`);
        }
      }
      restoredAgents[role] = {
        role,
        mount,
        preflight,
        preflightPath,
        assetCommit,
        assetCommitPath,
      };
    }
    const agents = {
      [ScoutAgentRoles.Coordinator]: requireRestoredAgent(
        restoredAgents,
        ScoutAgentRoles.Coordinator,
      ),
      [ScoutAgentRoles.Researcher]: requireRestoredAgent(
        restoredAgents,
        ScoutAgentRoles.Researcher,
      ),
      [ScoutAgentRoles.Verifier]: requireRestoredAgent(
        restoredAgents,
        ScoutAgentRoles.Verifier,
      ),
      [ScoutAgentRoles.Validator]: requireRestoredAgent(
        restoredAgents,
        ScoutAgentRoles.Validator,
      ),
    };
    scope.setEnvironment({
      agents,
      rootAccess: collectRunRootAccess(new AssetStore(), agents),
      contextBundle: buildRunContextBundle({
        runId: scope.runId,
        assetCommit: agents[ScoutAgentRoles.Coordinator].assetCommit,
      }),
    });
  }
}

function buildMount(assetCommit: AssetCommit): CodexMount {
  return {
    agentId: assetCommit.agentId,
    agentProfile: assetCommit.agentProfile,
    assetCommitId: assetCommit.assetCommitId,
    parentAssetCommitId: assetCommit.parentAssetCommitId,
    mountId: assetCommit.mountId,
    mountRoot: assetCommit.mountRoot,
    runRoot: assetCommit.runRoot,
    artifactRoot: assetCommit.artifactRoot,
    logsRoot: assetCommit.logsRoot,
    issues: assetCommit.issues,
    trustedRoots: assetCommit.trustedRoots,
    writableRoots: assetCommit.writableRoots,
    shellTools: assetCommit.shellTools,
    mcpServers: assetCommit.mcpServers,
    customAgents: assetCommit.customAgents,
    skills: assetCommit.skills,
    plugins: assetCommit.plugins,
    manifestPath: assetCommit.manifestPath,
    resourceHash: assetCommit.resourceHash,
  };
}

function collectRunRootAccess(
  assetStore: AssetStore,
  agents: Record<ScoutAgentRole, RunAgentEnvironment>,
): RunRootAccess {
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

function requireRestoredAgent(
  agents: Partial<Record<ScoutAgentRole, RunAgentEnvironment>>,
  role: ScoutAgentRole,
): RunAgentEnvironment {
  const agent = agents[role];
  if (!agent) throw new Error(`Run environment did not restore ${role}.`);
  return agent;
}

function resolveRunRef(runRoot: string, ref: string, label: string): string {
  const path = resolve(runRoot, ref);
  assertInsideRun(runRoot, path);
  if (path === runRoot) throw new Error(`Persisted ${label} does not name a file: ${ref}`);
  return path;
}

function requirePath(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`Run ${label} is missing: ${path}`);
}

function assertInsideRun(runRoot: string, path: string): void {
  assertInsideRoot(runRoot, path, "run path");
}

function assertInsideRoot(root: string, path: string, label: string): void {
  const rel = relative(root, resolve(path));
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) return;
  throw new Error(`Persisted ${label} escapes ${root}: ${path}`);
}

function uniqueResolved(values: string[]): string[] {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

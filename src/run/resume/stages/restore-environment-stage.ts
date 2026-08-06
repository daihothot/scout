import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  preflightCodexAppServerMount,
  summarizeAgentServerPreflight,
} from "../../../agent-server/codex/app-server-preflight.js";
import type { AgentServerPreflightReport } from "../../../agent-server/types.js";
import {
  AssetStore,
  type AssetCommit,
  type CodexMount,
  type MaterializeOptions,
  type MountManifest,
  resolveAssetLocalPath,
} from "../../../asset-store/index.js";
import { CodexAssetLayout } from "../../../asset-store/assets/asset-layout.js";
import {
  type ScoutAgentRole,
  ScoutAgentRoles,
} from "../../../agent/thread/types.js";
import {
  hashDirectory,
  readJsonFile,
  sha256File,
  writeJsonFile,
} from "../../../core/fs.js";
import { isPathWithin } from "../../../core/path.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../../lifecycle/index.js";
import {
  buildRunContextBundle,
  type RunAgentEnvironment,
} from "../../types.js";
import { buildRunRootAccess } from "../../root-access.js";
import type {
  MountRestoreProgress,
} from "../../../interaction/protocol/port.js";
import {
  applyMountMaterializationStep,
  applyMountPreflightStep,
  applyMountPreparationDecision,
  beginMountPreflightStep,
  completeMountRole,
  createMountRestoreProgress,
  discloseMountRestoreFailure,
  failMountRole,
  finishMountRestore,
  planMountRestore,
} from "../../mount-restore-progress.js";

export interface RestoreEnvironmentStageOptions {
  assetStore?: AssetStore;
  preflightMount?(mount: CodexMount): Promise<AgentServerPreflightReport>;
}

export class RestoreEnvironmentStage implements RunStage {
  readonly id = "restore_environment";
  private readonly options: RestoreEnvironmentStageOptions;

  constructor(options: RestoreEnvironmentStageOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    const scope = currentRunScope();
    const repoRoot = resolve(scope.repoRoot);
    const runRoot = resolve(repoRoot, "run", scope.runId);
    const repoRootReal = realpathSync(repoRoot);
    const runRootReal = requireContainedPath({
      root: repoRoot,
      rootReal: repoRootReal,
      path: runRoot,
      label: "run root",
      kind: "directory",
    });
    const manifest = scope.manifestStore.read();
    const manifestAgents = manifest.agents;
    if (!manifestAgents) throw new Error(`Run ${manifest.runId} has no persisted agent index.`);

    const agentsRoot = join(runRoot, "agents");
    requireContainedPath({
      root: runRoot,
      rootReal: runRootReal,
      path: agentsRoot,
      label: "agents root",
      kind: "directory",
    });
    const assetStore = this.options.assetStore ?? new AssetStore();
    const preflightMount = this.options.preflightMount ?? ((mount) =>
      preflightCodexAppServerMount({
        mount,
        appServer: currentRunScope().appServer,
      })
    );
    const restoredAgents: Partial<Record<ScoutAgentRole, RunAgentEnvironment>> = {};
    const progress = createMountRestoreProgress(Object.values(ScoutAgentRoles));
    await publishMountProgress(progress);
    const persistedAgents: Array<{
      role: ScoutAgentRole;
      mountManifestPath: string;
      assetCommitPath: string;
      preflightPath: string;
      mountManifest: MountManifest;
      assetCommit: AssetCommit;
      preflight: AgentServerPreflightReport;
      allowLegacyResourceIdentityMigration: boolean;
    }> = [];

    for (const role of Object.values(ScoutAgentRoles)) {
      try {
        const entry = manifestAgents[role];
        if (!entry) throw new Error(`Run ${manifest.runId} has no persisted index for ${role}.`);
        const agentRoot = join(agentsRoot, role);
        const mountRoot = join(agentRoot, "mount");
        const artifactRoot = join(agentRoot, "artifacts");
        requireContainedPath({
          root: runRoot,
          rootReal: runRootReal,
          path: agentRoot,
          label: `${role} agent root`,
          kind: "directory",
        });
        requireContainedPath({
          root: runRoot,
          rootReal: runRootReal,
          path: join(agentRoot, "logs"),
          label: `${role} logs root`,
          kind: "directory",
        });
        const mountManifestPath = resolveRunRef(runRoot, entry.mountManifestRef, "mount manifest");
        const assetCommitPath = resolveRunRef(runRoot, entry.assetCommitRef, "asset commit");
        const preflightPath = resolveRunRef(runRoot, entry.preflightRef, "preflight report");
        requireCanonicalRunRef(
          mountManifestPath,
          join(mountRoot, "mount-manifest.json"),
          `${role} mount manifest`,
        );
        requireCanonicalRunRef(
          assetCommitPath,
          join(artifactRoot, "asset-commit.json"),
          `${role} asset commit`,
        );
        requireCanonicalRunRef(
          preflightPath,
          join(artifactRoot, "app-server-preflight.json"),
          `${role} preflight report`,
        );
        requireContainedPath({
          root: runRoot,
          rootReal: runRootReal,
          path: mountManifestPath,
          label: `${role} mount manifest`,
          kind: "file",
        });
        requireContainedPath({
          root: runRoot,
          rootReal: runRootReal,
          path: assetCommitPath,
          label: `${role} asset commit`,
          kind: "file",
        });
        requireContainedPath({
          root: runRoot,
          rootReal: runRootReal,
          path: preflightPath,
          label: `${role} preflight report`,
          kind: "file",
        });

        const persistedMountManifest = readJsonFile<MountManifest>(mountManifestPath);
        const persistedAssetCommit = readJsonFile<AssetCommit>(assetCommitPath);
        const persistedPreflight = readJsonFile<AgentServerPreflightReport>(preflightPath);
        assertPersistedIdentity({
          role,
          entry,
          mountManifest: persistedMountManifest,
          assetCommit: persistedAssetCommit,
        });
        const allowLegacyResourceIdentityMigration = isLegacyResourceInventory(
          persistedMountManifest,
        );
        if (allowLegacyResourceIdentityMigration) {
          assertPersistedAssets(scope.repoRoot, role, persistedMountManifest);
        }

        persistedAgents.push({
          role,
          mountManifestPath,
          assetCommitPath,
          preflightPath,
          mountManifest: persistedMountManifest,
          assetCommit: persistedAssetCommit,
          preflight: persistedPreflight,
          allowLegacyResourceIdentityMigration,
        });
      } catch (error) {
        failMountRole(progress, role, "verify", errorText(error));
        await publishMountProgress(progress);
        await discloseMountRestoreFailure(scope.interactionPort, role, "verify", errorText(error));
        throw error;
      }
    }

    const preparationOptions = new Map<ScoutAgentRole, MaterializeOptions>();
    const decisions = new Map<ScoutAgentRole, {
      decision: "reused" | "rebuild";
      reason?: string;
    }>();
    for (const persisted of persistedAgents) {
      const {
        role,
        allowLegacyResourceIdentityMigration,
      } = persisted;
      const options: MaterializeOptions = {
        repoRoot: scope.repoRoot,
        runId: scope.runId,
        agentId: role,
        persistedManifest: persisted.mountManifest,
        cleanRunRoot: false,
        persistedIdentity: {
          assetCommitId: persisted.assetCommit.assetCommitId,
          parentAssetCommitId: persisted.assetCommit.parentAssetCommitId,
          mountId: persisted.assetCommit.mountId,
          resourceHash: persisted.assetCommit.resourceHash,
          allowLegacyResourceIdentityMigration,
        },
        onPreparationDecision: (nextDecision, reason) => {
          const plannedDecision = decisions.get(role)?.decision;
          if (plannedDecision !== nextDecision) {
            throw new Error(
              "Mount preparation changed after verification for " + role
              + ": planned=" + plannedDecision + " actual=" + nextDecision,
            );
          }
          applyMountPreparationDecision(progress, role, nextDecision, reason, true);
          void publishMountProgress(progress).catch(() => undefined);
        },
        onMaterializationStep: (step) => {
          applyMountMaterializationStep(progress, role, step);
          void publishMountProgress(progress).catch(() => undefined);
        },
      };
      preparationOptions.set(role, options);
      try {
        decisions.set(role, assetStore.inspectMount(options));
      } catch (error) {
        failMountRole(progress, role, "verify", errorText(error));
        await publishMountProgress(progress);
        await discloseMountRestoreFailure(scope.interactionPort, role, "verify", errorText(error));
        throw error;
      }
    }
    planMountRestore(progress, decisions);
    await publishMountProgress(progress);

    const restorePersistedMetadata = () => {
      for (const persisted of persistedAgents) {
        writeJsonFile(persisted.mountManifestPath, persisted.mountManifest);
        writeJsonFile(persisted.assetCommitPath, persisted.assetCommit);
        writeJsonFile(persisted.preflightPath, persisted.preflight);
      }
    };

    let agents: Record<ScoutAgentRole, RunAgentEnvironment>;
    try {
      for (const persisted of persistedAgents) {
        const {
          role,
          mountManifestPath,
          assetCommitPath,
          preflightPath,
          assetCommit: persistedAssetCommit,
          allowLegacyResourceIdentityMigration,
        } = persisted;
        if (progress.phase !== "failed") {
          progress.activeRole = role;
          progress.activeStep = "verify";
        }
        await publishMountProgress(progress);
        let mount: CodexMount;
        let decision: "reused" | "rebuild";
        try {
          const preparation = assetStore.prepareMount(preparationOptions.get(role)!);
          mount = preparation.mount;
          decision = preparation.decision;
        } catch (error) {
          const failureStep = progress.activeStep === "verify"
            ? "verify"
            : progress.activeStep ?? "wipe";
          failMountRole(
            progress,
            role,
            failureStep,
            errorText(error),
          );
          await publishMountProgress(progress);
          await discloseMountRestoreFailure(scope.interactionPort, role, failureStep, errorText(error));
          throw error;
        }
        if (decision === "rebuild") {
          beginMountPreflightStep(progress, role);
          await publishMountProgress(progress);
        }
        try {
          if (resolve(mount.manifestPath) !== mountManifestPath) {
            throw new Error(`Current mount manifest path does not match run index for ${role}.`);
          }
          const preflight = await preflightMount(mount);
          const preflightStatus = mount.issues.some((issue) => issue.severity === "error")
            ? "failed"
            : preflight.status;
          const assetCommit = assetStore.buildCommit({
            mount,
            preflightStatus,
            preflightPath,
          });
          if (preflightStatus !== "passed" || assetCommit.status !== "preflight_passed") {
            failMountRole(progress, role, "preflight", preflight.error);
            await publishMountProgress(progress);
            await discloseMountRestoreFailure(
              scope.interactionPort,
              role,
              "preflight",
              preflight.error ?? "preflight failed",
            );
          } else if (decision === "rebuild") {
            applyMountPreflightStep(progress, role);
            completeMountRole(progress, role);
            await publishMountProgress(progress);
          }
          restoredAgents[role] = {
            role,
            mount,
            preflight,
            preflightPath,
            assetCommit,
            assetCommitPath,
          };
        } catch (error) {
          if (progress.phase !== "failed") {
            failMountRole(progress, role, "preflight", errorText(error));
            await publishMountProgress(progress);
            await discloseMountRestoreFailure(scope.interactionPort, role, "preflight", errorText(error));
          }
          throw error;
        }
      }

      agents = requireRestoredAgents(restoredAgents);
      if (!Object.values(agents).every((agent) =>
        agent.assetCommit.status === "preflight_passed"
      )) {
        const failures = Object.values(agents)
          .filter((agent) => agent.assetCommit.status !== "preflight_passed")
          .map((agent) => {
            const reasons = [
              ...agent.mount.issues
                .filter((issue) => issue.severity === "error")
                .map((issue) => `${issue.code}: ${issue.message}`),
              ...(agent.preflight.rootAccess?.roots ?? [])
                .filter((root) => root.status === "failed")
                .map((root) => `root ${root.path}: ${root.error ?? "failed"}`),
              ...(agent.preflight.shellSmoke ?? [])
                .filter((smoke) => smoke.status === "failed")
                .map((smoke) =>
                  `shell ${smoke.command}: ${smoke.error ?? smoke.stderr ?? "failed"}`
                ),
              ...(agent.preflight.pluginGate?.status === "failed"
                ? agent.preflight.pluginGate.plugins
                    .filter((plugin) => !plugin.installedAfter || !plugin.enabledAfter)
                    .map((plugin) =>
                      `plugin ${plugin.pluginName}: installed=${plugin.installedAfter}`
                      + ` enabled=${plugin.enabledAfter}`
                    )
                : []),
              ...(agent.preflight.error
                ? [`app-server: ${agent.preflight.error.split("\n", 1)[0]}`]
                : []),
            ];
            return `${agent.role} (${reasons.join(", ") || "status=failed"})`;
          });
        throw new Error(`Scout run restore preflight failed: ${failures.join("; ")}.`);
      }
    } catch (error) {
      restorePersistedMetadata();
      throw error;
    }

    try {
      for (const agent of Object.values(agents)) {
        writeJsonFile(
          agent.preflightPath,
          summarizeAgentServerPreflight(agent.preflight, agent.mount),
        );
        writeJsonFile(agent.assetCommitPath, agent.assetCommit);
      }
      if (Object.values(agents).some((agent) =>
        manifestAgents[agent.role].resourceHash !== agent.assetCommit.resourceHash
      )) {
        scope.manifestStore.update((current) => {
          if (!current.agents) {
            throw new Error(`Run ${current.runId} has no persisted agent index.`);
          }
          return {
            ...current,
            agents: {
              [ScoutAgentRoles.Coordinator]: {
                ...current.agents[ScoutAgentRoles.Coordinator],
                resourceHash: agents[ScoutAgentRoles.Coordinator].assetCommit.resourceHash,
              },
              [ScoutAgentRoles.Researcher]: {
                ...current.agents[ScoutAgentRoles.Researcher],
                resourceHash: agents[ScoutAgentRoles.Researcher].assetCommit.resourceHash,
              },
              [ScoutAgentRoles.Verifier]: {
                ...current.agents[ScoutAgentRoles.Verifier],
                resourceHash: agents[ScoutAgentRoles.Verifier].assetCommit.resourceHash,
              },
              [ScoutAgentRoles.Validator]: {
                ...current.agents[ScoutAgentRoles.Validator],
                resourceHash: agents[ScoutAgentRoles.Validator].assetCommit.resourceHash,
              },
            },
          };
        });
      }
    } catch (error) {
      restorePersistedMetadata();
      throw error;
    }
    scope.setEnvironment({
      agents,
      rootAccess: buildRunRootAccess(assetStore, agents),
      contextBundle: buildRunContextBundle({
        runId: scope.runId,
        assetCommit: agents[ScoutAgentRoles.Coordinator].assetCommit,
      }),
    });
    finishMountRestore(progress);
    await publishMountProgress(progress);
  }
}

async function publishMountProgress(progress: MountRestoreProgress): Promise<void> {
  await currentRunScope().interactionPort.publishMountRestoreProgress({
    ...progress,
    roles: progress.roles.map((role) => ({ ...role })),
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPersistedIdentity(input: {
  role: ScoutAgentRole;
  entry: {
    mountId: string;
    assetCommitId: string;
    resourceHash: string;
  };
  mountManifest: MountManifest;
  assetCommit: AssetCommit;
}): void {
  const { role, entry, mountManifest, assetCommit } = input;
  if (
    mountManifest.agentId !== role
    || assetCommit.agentId !== role
    || mountManifest.mountId !== entry.mountId
    || assetCommit.mountId !== entry.mountId
    || mountManifest.assetCommitId !== entry.assetCommitId
    || assetCommit.assetCommitId !== entry.assetCommitId
    || mountManifest.resourceHash !== entry.resourceHash
    || assetCommit.resourceHash !== entry.resourceHash
    || mountManifest.parentAssetCommitId !== assetCommit.parentAssetCommitId
    || JSON.stringify(mountManifest.agentProfile) !== JSON.stringify(assetCommit.agentProfile)
  ) {
    throw new Error(`Persisted mount identity does not match run index for ${role}.`);
  }
}

function assertPersistedAssets(
  repoRoot: string,
  role: ScoutAgentRole,
  mountManifest: MountManifest,
): void {
  const assetsRoot = join(resolve(repoRoot), "assets", "codex");
  for (const asset of mountManifest.assets) {
    if (isCanonicalShellToolsRegistryAsset(asset)) continue;
    const sourcePath = resolveAssetLocalPath(asset.sourcePath, assetsRoot);
    assertInsideRoot(assetsRoot, sourcePath, "asset source");
    requirePath(sourcePath, `asset source ${asset.id}`);
    const actualHash = asset.type === "plugin"
      || asset.type === "skill"
      || asset.type === "mcp_server_vendor"
      ? hashDirectory(sourcePath)
      : sha256File(sourcePath);
    if (actualHash !== asset.hash) {
      throw new Error(`Persisted asset changed for ${role}: ${asset.sourcePath}`);
    }
  }
}

function isCanonicalShellToolsRegistryAsset(asset: MountManifest["assets"][number]): boolean {
  return asset.id === "codex.shell_tools"
    && asset.type === "shell_tool_contract"
    && asset.sourcePath === join("assets", "codex", CodexAssetLayout.shellTools);
}

function isLegacyResourceInventory(mountManifest: MountManifest): boolean {
  if (mountManifest.resourceInventoryVersion !== undefined) return false;
  return !mountManifest.assets.some((asset) =>
    asset.type === "shell_tool_resource"
    || asset.type === "mcp_server_resource"
    || asset.type === "mcp_server_vendor"
  );
}

function requireRestoredAgents(
  agents: Partial<Record<ScoutAgentRole, RunAgentEnvironment>>,
): Record<ScoutAgentRole, RunAgentEnvironment> {
  return {
    [ScoutAgentRoles.Coordinator]: requireRestoredAgent(
      agents,
      ScoutAgentRoles.Coordinator,
    ),
    [ScoutAgentRoles.Researcher]: requireRestoredAgent(
      agents,
      ScoutAgentRoles.Researcher,
    ),
    [ScoutAgentRoles.Verifier]: requireRestoredAgent(
      agents,
      ScoutAgentRoles.Verifier,
    ),
    [ScoutAgentRoles.Validator]: requireRestoredAgent(
      agents,
      ScoutAgentRoles.Validator,
    ),
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

function requireCanonicalRunRef(path: string, expectedPath: string, label: string): void {
  if (resolve(path) !== resolve(expectedPath)) {
    throw new Error(`Persisted ${label} must resolve to ${expectedPath}, received ${path}.`);
  }
}

function requireContainedPath(input: {
  root: string;
  rootReal: string;
  path: string;
  label: string;
  kind: "directory" | "file";
}): string {
  const path = resolve(input.path);
  if (!isPathWithin(input.root, path, { allowRoot: false })) {
    throw new Error(`Persisted ${input.label} escapes ${input.root}: ${path}`);
  }

  let current = input.root;
  const components = relative(input.root, path).split(sep);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      throw new Error(`Cannot inspect persisted ${input.label} component ${current}.`, {
        cause: error,
      });
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlinked persisted ${input.label} component: ${current}.`);
    }
    const expectedKind = index === components.length - 1 ? input.kind : "directory";
    if (expectedKind === "directory" && !stat.isDirectory()) {
      throw new Error(
        `Expected persisted ${input.label} component to be a directory: ${current}.`,
      );
    }
    if (expectedKind === "file" && !stat.isFile()) {
      throw new Error(`Expected persisted ${input.label} to be a regular file: ${current}.`);
    }
  }

  const pathReal = realpathSync(path);
  assertInsideRoot(input.rootReal, pathReal, input.label);
  return pathReal;
}

function assertInsideRun(runRoot: string, path: string): void {
  assertInsideRoot(runRoot, path, "run path");
}

function assertInsideRoot(root: string, path: string, label: string): void {
  if (isPathWithin(root, path)) return;
  throw new Error(`Persisted ${label} escapes ${root}: ${path}`);
}

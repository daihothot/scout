import {
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { AgentServerPreflightReport } from "../../agent-server/types.js";
import {
  type AssetCommit,
  type MountManifest,
} from "../../asset-store/index.js";
import {
  type ScoutAgentRole,
} from "../../agent/thread/types.js";
import {
  readJsonFile,
} from "../../core/fs.js";
import { isPathWithin } from "../../core/path.js";
import type { RunManifest } from "../persistence/index.js";
import {
  type EnvironmentSnapshot,
  type PersistedEnvironmentAgent,
} from "./types.js";

/** Identifies the role whose persisted environment could not be validated. */
export class EnvironmentSnapshotLoadError extends Error {
  readonly role: ScoutAgentRole;

  constructor(role: ScoutAgentRole, cause: unknown) {
    super(`Failed to load persisted environment for ${role}: ${errorText(cause)}`, { cause });
    this.name = "EnvironmentSnapshotLoadError";
    this.role = role;
  }
}

/**
 * Loads the persisted role facts required by resume after proving that every
 * reference resolves to its canonical regular file beneath the current run.
 * Resource reuse and drift decisions belong to the mount inspection pipeline.
 */
export class EnvironmentSnapshotLoader {
  constructor(
    private readonly input: {
      readonly scoutRoot: string;
      readonly runRoot: string;
      readonly manifest: RunManifest;
      readonly roles: readonly ScoutAgentRole[];
    },
  ) {}

  load(): EnvironmentSnapshot {
    const scoutRoot = resolve(this.input.scoutRoot);
    const runRoot = resolve(this.input.runRoot);
    const scoutRootReal = realpathSync(scoutRoot);
    const runRootReal = requireContainedPath({
      root: scoutRoot,
      rootReal: scoutRootReal,
      path: runRoot,
      label: "run root",
      kind: "directory",
    });
    const manifest = this.input.manifest;
    if (manifest.runId !== basename(runRoot)) {
      throw new Error(
        `Persisted environment run id ${manifest.runId} does not match ${runRoot}.`,
      );
    }
    const manifestAgents = manifest.agents;
    if (!manifestAgents) {
      throw new Error(`Run ${manifest.runId} has no persisted agent index.`);
    }

    const agentsRoot = join(runRoot, "agents");
    requireContainedPath({
      root: runRoot,
      rootReal: runRootReal,
      path: agentsRoot,
      label: "agents root",
      kind: "directory",
    });

    const agents: PersistedEnvironmentAgent[] = [];
    for (const role of this.input.roles) {
      try {
        agents.push(this.loadRole({
          role,
          manifest,
          manifestAgents,
          agentsRoot,
          runRoot,
          runRootReal,
        }));
      } catch (error) {
        throw new EnvironmentSnapshotLoadError(role, error);
      }
    }

    return { manifest, agents };
  }

  private loadRole(input: {
    role: ScoutAgentRole;
    manifest: RunManifest;
    manifestAgents: NonNullable<RunManifest["agents"]>;
    agentsRoot: string;
    runRoot: string;
    runRootReal: string;
  }): PersistedEnvironmentAgent {
    const {
      role,
      manifest,
      manifestAgents,
      agentsRoot,
      runRoot,
      runRootReal,
    } = input;
    const entry = manifestAgents[role];
    if (!entry) {
      throw new Error(`Run ${manifest.runId} has no persisted index for ${role}.`);
    }

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

    const mountManifest = readJsonFile<MountManifest>(mountManifestPath);
    const assetCommit = readJsonFile<AssetCommit>(assetCommitPath);
    const preflight = readJsonFile<AgentServerPreflightReport>(preflightPath);
    assertPersistedIdentity({
      role,
      entry,
      mountManifest,
      assetCommit,
    });
    return {
      role,
      mountManifestPath,
      assetCommitPath,
      preflightPath,
      mountManifest,
      assetCommit,
      preflight,
    };
  }
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

function resolveRunRef(runRoot: string, ref: string, label: string): string {
  const path = resolve(runRoot, ref);
  assertInsideRun(runRoot, path);
  if (path === runRoot) throw new Error(`Persisted ${label} does not name a file: ${ref}`);
  return path;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  sha256Text,
  stableJson,
} from "../../core/fs.js";
import { isPathWithin } from "../../core/path.js";
import type { RunManifest } from "../persistence/index.js";
import { assertMountPathSegment } from "../../asset-store/files/asset-paths.js";
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

  /** Validates an interrupted environment transaction before any repair writes. */
  static readRollback(scoutRoot: string, runRoot: string): EnvironmentSnapshot | undefined {
    scoutRoot = resolve(scoutRoot);
    runRoot = resolve(runRoot);
    const runRootReal = requireContainedPath({
      root: scoutRoot,
      rootReal: realpathSync(scoutRoot),
      path: runRoot,
      label: "run root",
      kind: "directory",
    });
    const path = join(runRoot, "environment-rollback.json");
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    requireContainedPath({
      root: runRoot,
      rootReal: runRootReal,
      path,
      label: "environment rollback record",
      kind: "file",
    });
    requireContainedPath({
      root: runRoot,
      rootReal: runRootReal,
      path: join(runRoot, "run.json"),
      label: "run manifest",
      kind: "file",
    });
    const record = readJsonFile<{
      version: number;
      checksum: string;
      runId: string;
      manifest: RunManifest;
      agents: Array<Pick<PersistedEnvironmentAgent,
        "role" | "mountManifest" | "assetCommit" | "preflight">>;
    }>(path);
    if (record?.version !== 1
      || record.runId !== basename(runRoot)
      || record.manifest?.version !== 1
      || record.manifest.runId !== record.runId
      || !record.manifest.agents || Array.isArray(record.manifest.agents)
      || !Array.isArray(record.agents)) {
      throw new Error(`Invalid environment rollback record: ${path}.`);
    }
    const { checksum, ...captured } = record;
    if (checksum !== sha256Text(stableJson(captured))) {
      throw new Error(`Environment rollback record checksum mismatch: ${path}.`);
    }
    // The whole index is restored, including roles not selected by the current
    // profile. None of its references may introduce a different destination.
    for (const [role, entry] of Object.entries(record.manifest.agents)) {
      assertMountPathSegment(role, "environment rollback indexed role");
      if (!entry || typeof entry !== "object"
        || [entry.mountId, entry.assetCommitId, entry.resourceHash,
          entry.mountManifestRef, entry.assetCommitRef, entry.preflightRef].some((value) =>
          typeof value !== "string" || value.length === 0
        )) {
        throw new Error(`Invalid captured environment index for ${role}.`);
      }
      const agentRoot = join(runRoot, "agents", role);
      for (const [ref, expected] of [
        [entry.mountManifestRef, join(agentRoot, "mount", "mount-manifest.json")],
        [entry.assetCommitRef, join(agentRoot, "artifacts", "asset-commit.json")],
        [entry.preflightRef, join(agentRoot, "artifacts", "app-server-preflight.json")],
      ] as const) {
        requireCanonicalRunRef(resolveRunRef(runRoot, ref, "environment rollback artifact"),
          expected, `${role} rollback artifact`);
      }
    }
    const roles = new Set<string>();
    for (const captured of record.agents) {
      if (!captured || typeof captured.role !== "string"
        || !captured.mountManifest || !captured.assetCommit
        || !captured.preflight
        || !["passed", "failed"].includes(captured.preflight.status)) {
        throw new Error(`Invalid captured environment role in ${path}.`);
      }
      assertMountPathSegment(captured.role, "environment rollback role");
      if (roles.has(captured.role)) {
        throw new Error(`Duplicate environment rollback role: ${captured.role}.`);
      }
      roles.add(captured.role);
    }
    return new EnvironmentSnapshotLoader({
      scoutRoot,
      runRoot,
      manifest: record.manifest,
      roles: [...roles],
    }).loadSnapshot(record.agents);
  }

  load(): EnvironmentSnapshot {
    return this.loadSnapshot();
  }

  private loadSnapshot(capturedAgents?: readonly Pick<PersistedEnvironmentAgent,
    "role" | "mountManifest" | "assetCommit" | "preflight">[]): EnvironmentSnapshot {
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
          captured: capturedAgents?.find((agent) => agent.role === role),
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
    captured?: Pick<PersistedEnvironmentAgent, "mountManifest" | "assetCommit" | "preflight">;
  }): PersistedEnvironmentAgent {
    const {
      role,
      manifest,
      manifestAgents,
      agentsRoot,
      runRoot,
      runRootReal,
      captured,
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
      allowMissing: captured !== undefined,
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

    const mountManifest = captured?.mountManifest ?? readJsonFile<MountManifest>(mountManifestPath);
    const assetCommit = captured?.assetCommit ?? readJsonFile<AssetCommit>(assetCommitPath);
    const preflight = captured?.preflight ?? readJsonFile<AgentServerPreflightReport>(preflightPath);
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
    [entry.mountId, entry.assetCommitId, entry.resourceHash].some((value) =>
      typeof value !== "string" || value.length === 0
    )
    || !mountManifest.agentProfile || !assetCommit.agentProfile
    || mountManifest.agentId !== role
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
  allowMissing?: boolean;
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
      if (input.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return path;
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

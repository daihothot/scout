import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { currentRunScope } from "../../run/run-scope.js";
import type { WorkflowStorageLock } from "./workflow-storage-lock.js";

/** Physical Workflow storage selected by its stable identity, not its directory name. */
export interface WorkflowLocation {
  workflowId: string;
  workflowRoot: string;
  journalRoot: string;
}

/** Controls whether lexical containment accepts the root path itself. */
export interface PathWithinOptions {
  allowRoot?: boolean;
}

/** Identifies an artifact independently of its Workflow directory and originating Run. */
export interface ScoutArtifactReference {
  readonly workflowId: string;
  readonly agentId: string;
  readonly path: string;
}

/** Replaces the current Agent's physical artifact path with a stable Workflow identity reference. */
export function canonicalizeAgentArtifactReferences(
  value: string,
  input: { workflowId: string; agentId: string; artifactRoot: string },
): string {
  const root = resolve(input.artifactRoot);
  return value.replaceAll(`${root}${sep}`, `scout-artifact://${input.workflowId}/${input.agentId}/`);
}

/** Supplies physical paths for known artifact roots; it neither registers nor grants access. */
export function resolveAgentArtifactReferences(
  value: string,
  input: {
    workflowId: string;
    artifacts: readonly { agentId: string; path: string }[];
    readRequests: readonly { artifact_ref: string; read_path: string }[];
  },
): { ref: string; path: string }[] {
  const resolved = new Map<string, string>();
  // Quoted references may contain spaces; bare references end at text/Markdown delimiters.
  const references = /(["'`])(scout-artifact:\/\/[^"'`\r\n]+)\1|(scout-artifact:\/\/[^\s"'`<>()\[\]{},;*]+)/g;
  const roots = [
    ...input.artifacts.map((artifact) => ({ prefix: `scout-artifact://${input.workflowId}/${artifact.agentId}/`, path: artifact.path })),
    ...input.readRequests.map((request) => ({ prefix: `${request.artifact_ref}/`, path: request.read_path })),
  ];
  for (const match of value.matchAll(references)) {
    const ref = match[2] ?? match[3]!;
    if (resolved.has(ref)) continue;
    const root = roots.find(({ prefix }) => ref.startsWith(prefix));
    if (!root) continue;
    const relativePath = ref.slice(root.prefix.length);
    if (!relativePath || isAbsolute(relativePath) || /[\u0000-\u001f\u007f\\]/.test(relativePath)) continue;
    const path = resolve(root.path, relativePath);
    if (!isPathWithin(root.path, path, { allowRoot: false })) continue;
    resolved.set(ref, path);
  }
  return [...resolved].map(([ref, path]) => ({ ref, path }));
}

/** Parses an external stable reference; paths are literal, never URL-decoded. */
export function parseArtifactReference(reference: string): ScoutArtifactReference {
  const match = /^scout-artifact:\/\/([^/]+)\/([A-Za-z0-9_-]+)\/(.+)$/.exec(reference);
  if (!match || match[1]!.trim() !== match[1] || /[\u0000-\u001f\u007f\\]/.test(reference)
    || match[3]!.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid scout-artifact reference.");
  }
  return { workflowId: match[1]!, agentId: match[2]!, path: match[3]! };
}

/** Resolves current physical evidence by identity and rejects escaping or symlinked read targets. */
export function resolveArtifactTarget(target: ScoutArtifactReference): { path: string } | { reason: string } {
  const location = resolveWorkflowLocation(currentRunScope().runRoot, target.workflowId);
  if (!location) return { reason: `Artifact target Workflow is unavailable: ${target.workflowId}` };
  // Workflow identity corruption is a system error, not an unavailable file.
  try {
    const workflowRoot = realpathSync(location.workflowRoot);
    const artifactRoot = resolve(workflowAgentPaths(workflowRoot, target.agentId).artifactRoot);
    const ownerPath = relative(workflowPaths(workflowRoot).agentsRoot, artifactRoot);
    if (isAbsolute(ownerPath) || ownerPath.split(sep).length !== 2 || ownerPath.split(sep)[0] === "..") {
      return { reason: "Artifact target escapes its Agent artifact owner." };
    }
    if (isAbsolute(target.path)) return { reason: "Artifact target path must be relative to Agent artifacts." };
    const path = resolve(artifactRoot, target.path);
    if (!isPathWithin(artifactRoot, path)) return { reason: "Artifact target escapes Agent artifacts." };
    let cursor = workflowRoot;
    for (const part of relative(workflowRoot, path).split(sep)) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) return { reason: "Artifact target cannot traverse a symbolic link." };
    }
    const stats = lstatSync(path);
    if (!stats.isFile() && !stats.isDirectory()) return { reason: "Artifact target must be a file or directory." };
    return { path: realpathSync(path) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return { reason: "Artifact target is unavailable." };
    }
    throw error;
  }
}

/**
 * Tests lexical containment after normalizing both paths, without resolving symlinks.
 * Filesystem callers must perform their own realpath/lstat checks when that matters.
 */
export function isPathWithin(
  root: string,
  target: string,
  options: PathWithinOptions = {},
): boolean {
  const pathFromRoot = relative(resolve(root), resolve(target));
  if (pathFromRoot === "") return options.allowRoot !== false;
  return !isAbsolute(pathFromRoot)
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`);
}

/** Scout-owned Run directory layout; these functions perform no filesystem IO. */
export function scoutRunsRoot(scoutRoot: string): string {
  return join(scoutRoot, "run");
}

export function scoutRunRoot(scoutRoot: string, runId: string): string {
  return join(scoutRunsRoot(scoutRoot), runId);
}

export function runPaths(runRoot: string) {
  const isolatedHome = join(runRoot, "codex-home");
  const codexHome = join(isolatedHome, ".codex");
  return {
    agentsRoot: join(runRoot, "agents"),
    logsRoot: join(runRoot, "logs"),
    workflowsRoot: join(runRoot, "workflows"),
    manifestPath: join(runRoot, "run.json"),
    benchmarksPath: join(runRoot, "benchmarks.json"),
    workflowLockPath: join(runRoot, ".workflow.lock"),
    environmentRollbackPath: join(runRoot, "environment-rollback.json"),
    isolatedHome,
    codexHome,
    codexSessionsRoot: join(codexHome, "sessions"),
  };
}

/** Agent entity storage persists independently of the current Workflow. */
export function agentEntityPaths(agentRoot: string) {
  const mountRoot = join(agentRoot, "mount");
  return {
    mountRoot,
    mountManifestPath: join(mountRoot, "mount-manifest.json"),
    assetCommitPath: join(agentRoot, "asset-commit.json"),
    preflightPath: join(agentRoot, "app-server-preflight.json"),
    threadRecordPath: join(agentRoot, "thread.json"),
    logsRoot: join(agentRoot, "logs"),
  };
}

export function runAgentPaths(runRoot: string, agentId: string) {
  const agentRoot = join(runPaths(runRoot).agentsRoot, agentId);
  return { agentRoot, ...agentEntityPaths(agentRoot) };
}

/** Uses the selected physical directory, never a directory inferred from Workflow identity. */
export function workflowPaths(workflowRoot: string) {
  return {
    identityPath: join(workflowRoot, "workflow.json"),
    agentsRoot: join(workflowRoot, "agents"),
    journalRoot: join(workflowRoot, "journal"),
  };
}

export function workflowRootFromJournalRoot(journalRoot: string): string {
  return dirname(journalRoot);
}

/** Reads a manually editable Workflow identity; absent identity files are not Workflows. */
export function readWorkflowIdentity(workflowRoot: string): string | undefined {
  const { identityPath } = workflowPaths(workflowRoot);
  if (!existsSync(identityPath)) return undefined;
  const identity: unknown = JSON.parse(readFileSync(identityPath, "utf8"));
  if (typeof identity !== "object" || identity === null || !("workflowId" in identity)
    || typeof identity.workflowId !== "string" || !/^workflow-[0-9]{3,}$/.test(identity.workflowId)) {
    throw new Error(`Invalid Workflow identity: ${identityPath}`);
  }
  return identity.workflowId;
}

/** Locates a retained Workflow after rename or import without consulting any Benchmark chapter. */
export function resolveWorkflowLocation(runRoot: string, workflowId: string): WorkflowLocation | undefined {
  if (!/^workflow-[0-9]{3,}$/.test(workflowId)) throw new Error(`Invalid Workflow reference: ${workflowId}`);
  const { workflowsRoot } = runPaths(runRoot);
  if (!existsSync(workflowsRoot)) return undefined;
  let found: WorkflowLocation | undefined;
  for (const entry of readdirSync(workflowsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workflowRoot = join(workflowsRoot, entry.name);
    if (readWorkflowIdentity(workflowRoot) !== workflowId) continue;
    if (found) throw new Error(`Duplicate Workflow identity ${workflowId}: ${found.workflowRoot}, ${workflowRoot}`);
    found = { workflowId, workflowRoot, journalRoot: workflowPaths(workflowRoot).journalRoot };
  }
  return found;
}

/** Inspects an allocation target under the runtime lease; replacement policy belongs to Workflow. */
export function inspectWorkflowDirectory(storage: WorkflowStorageLock, workflowId: string): {
  location: WorkflowLocation;
  replacedWorkflowId: string | undefined;
} {
  storage.assertOwned();
  const workflowRoot = join(runPaths(storage.runRoot).workflowsRoot, workflowId);
  const existing = resolveWorkflowLocation(storage.runRoot, workflowId);
  if (existing && existing.workflowRoot !== workflowRoot) {
    throw new Error(`Cannot allocate existing Workflow identity ${workflowId}: ${existing.workflowRoot}`);
  }
  return {
    location: { workflowId, workflowRoot, journalRoot: workflowPaths(workflowRoot).journalRoot },
    replacedWorkflowId: existsSync(workflowRoot) ? readWorkflowIdentity(workflowRoot) ?? workflowId : undefined,
  };
}

/** Creates the exact approved allocation target, forcefully replacing only that directory. */
export function createWorkflowDirectory(storage: WorkflowStorageLock, location: WorkflowLocation): WorkflowLocation {
  storage.assertOwned();
  const { workflowId, workflowRoot, journalRoot } = location;
  const { identityPath } = workflowPaths(workflowRoot);
  if (existsSync(workflowRoot)) rmSync(workflowRoot, { recursive: true, force: true });
  mkdirSync(journalRoot, { recursive: true });
  writeFileSync(identityPath, `${JSON.stringify({ workflowId }, null, 2)}\n`, "utf8");
  return location;
}

/** Creates Agent evidence roots after the Workflow allocation is available for failure cleanup. */
export function createWorkflowAgentDirectories(storage: WorkflowStorageLock, workflowRoot: string, agentIds: readonly string[]): void {
  storage.assertOwned();
  for (const agentId of agentIds) {
    const { artifactRoot, logsRoot } = workflowAgentPaths(workflowRoot, agentId);
    mkdirSync(artifactRoot, { recursive: true });
    mkdirSync(logsRoot, { recursive: true });
  }
}

/** Removes one uncommitted allocation, never a sibling Run directory or the storage root. */
export function discardWorkflowDirectory(storage: WorkflowStorageLock, prepared: WorkflowLocation): void {
  storage.assertOwned();
  const expectedRoot = join(runPaths(storage.runRoot).workflowsRoot, prepared.workflowId);
  if (!/^workflow-[0-9]{3,}$/.test(prepared.workflowId)
    || resolve(prepared.workflowRoot) !== expectedRoot
    || resolve(prepared.journalRoot) !== workflowPaths(expectedRoot).journalRoot) {
    throw new Error(`Prepared Workflow root does not match ${prepared.workflowId}: ${prepared.journalRoot}`);
  }
  rmSync(expectedRoot, { recursive: true, force: true });
}

/** Both Workflow preparation and current execution use this Agent evidence layout. */
export function workflowAgentPaths(workflowRoot: string, agentId: string) {
  const root = join(workflowRoot, "agents", agentId);
  return { artifactRoot: join(root, "artifacts"), logsRoot: join(root, "logs") };
}

export function scoutJournalPaths(journalRoot: string) {
  return {
    path: join(journalRoot, "scout.journal"),
    lockPath: join(journalRoot, ".scout.lock"),
  };
}

/** Recording file locations are always relative to the selected Workflow journal root. */
export function recordObjectPaths(journalRoot: string, fileName: string, lockFileName: string) {
  return { path: join(journalRoot, fileName), lockPath: join(journalRoot, lockFileName) };
}

export function authorizationJournalPaths(journalRoot: string) {
  return recordObjectPaths(journalRoot, "authorization.journal", ".authorization.lock");
}

/** Selects execution telemetry storage without creating or retaining a Workflow. */
export function agentTelemetryLogsRoot(agentId: string): string {
  const scope = currentRunScope();
  if (scope.workflow.snapshot()) {
    return scope.workflow.agentPaths(agentId).logsRoot;
  }
  return agentEntityPaths(scope.agentRegistry.resolveAgent(agentId).mount.agentRoot).logsRoot;
}

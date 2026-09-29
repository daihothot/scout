import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { currentRunScope } from "../run/run-scope.js";

/** Controls whether lexical containment accepts the root path itself. */
export interface PathWithinOptions {
  allowRoot?: boolean;
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
    journalRoot: join(workflowRoot, "journal"),
  };
}

export function workflowRootFromJournalRoot(journalRoot: string): string {
  return dirname(journalRoot);
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

/** Selects execution telemetry storage without creating or retaining a Workflow. */
export function agentTelemetryLogsRoot(agentId: string): string {
  const scope = currentRunScope();
  if (scope.workflow.snapshot()) {
    return scope.workflow.agentPaths(agentId).logsRoot;
  }
  return agentEntityPaths(scope.agentRegistry.resolveAgent(agentId).mount.agentRoot).logsRoot;
}

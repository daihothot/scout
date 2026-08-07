import {
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
  RunAppServerStage,
  type RunStage,
} from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";
import { isPathWithin } from "../../../core/path.js";

/**
 * Reopens the run-scoped Codex client after validating that its copied home
 * and sessions remain inside the run root. Client startup is delegated to the
 * normal app-server lifecycle stage; this wrapper only supplies resume-time
 * containment and ownership boundaries.
 */
export class ResumeClientsStage implements RunStage {
  readonly id = "restore_clients";
  private stage?: RunAppServerStage;

  /** Validates copied Codex state, then starts the app-server client stage. */
  async start(): Promise<void> {
    assertRunCodexHomeIsContained();
    const stage = new RunAppServerStage();
    await stage.start();
    this.stage = stage;
  }

  /** Delegates client shutdown and releases the stage reference. */
  async stop(reason: string): Promise<void> {
    await this.stage?.stop();
    this.stage = undefined;
  }
}

/** Rejects copied Codex homes that escape the run root or contain symlinks. */
function assertRunCodexHomeIsContained(): void {
  const scope = currentRunScope();
  const repoRoot = resolve(scope.repoRoot);
  const runRoot = resolve(repoRoot, "run", scope.runId);
  const codexRoot = join(runRoot, "codex-home", ".codex");
  const sessionsRoot = join(codexRoot, "sessions");
  const requireDirectoryChain = (
    root: string,
    target: string,
    label: string,
  ): void => {
    if (!isPathWithin(root, target, { allowRoot: false })) {
      throw new Error(`${label} escapes ${root}: ${target}.`);
    }
    const pathFromRoot = relative(root, target);
    let current = root;
    for (const component of pathFromRoot.split(sep)) {
      current = join(current, component);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        throw new Error(`Cannot inspect ${label} component ${current}.`, { cause: error });
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symlinked ${label} component: ${current}.`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Expected ${label} component to be a directory: ${current}.`);
      }
    }
  };
  const assertInside = (path: string, root: string, label: string): void => {
    if (isPathWithin(root, path)) return;
    throw new Error(`${label} escapes ${root}: ${path}.`);
  };
  const requireRegularFileIfPresent = (path: string, label: string): void => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Cannot inspect ${label} ${path}.`, { cause: error });
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlinked Codex home component: ${path}.`);
    }
    if (!stat.isFile()) {
      throw new Error(`Expected ${label} to be a regular file: ${path}.`);
    }
    assertInside(realpathSync(path), runRootReal, label);
  };

  requireDirectoryChain(repoRoot, runRoot, "run root");
  const repoRootReal = realpathSync(repoRoot);
  const runRootReal = realpathSync(runRoot);
  assertInside(runRootReal, repoRootReal, "Run root");
  requireDirectoryChain(runRoot, sessionsRoot, "Codex home");
  assertInside(realpathSync(sessionsRoot), runRootReal, "Codex sessions root");
  requireRegularFileIfPresent(join(codexRoot, "config.toml"), "Codex config");
}

import {
  lstatSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  AppServerRootConfigStage,
  RunAppServerStage,
  type RunStage,
} from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";
import { isPathWithin, runPaths } from "../../../core/path.js";

/**
 * Reopens the run-scoped Codex client after validating that its copied home
 * and sessions remain inside the run root. Client startup is delegated to the
 * normal app-server lifecycle stage; this wrapper only supplies resume-time
 * containment and ownership boundaries.
 */
export class ResumeClientsStage implements RunStage {
  readonly id = "restore_clients";
  private stage?: RunAppServerStage;
  private rootConfigStage?: AppServerRootConfigStage;

  constructor(private readonly options: {
    /** Only the resume entry point may establish that initialization never finished. */
    allowMissingHome?: boolean;
  } = {}) {}

  /** Validates copied Codex state, then starts the app-server client stage. */
  async start(): Promise<void> {
    assertRunCodexHomeIsContained(this.options.allowMissingHome === true);
    const rootConfigStage = new AppServerRootConfigStage();
    try {
      await rootConfigStage.start();
      const stage = new RunAppServerStage({ rootConfigStage });
      await stage.start();
      this.rootConfigStage = rootConfigStage;
      this.stage = stage;
    } catch (error) {
      await rootConfigStage.stop();
      throw error;
    }
  }

  /** Delegates client shutdown and releases the stage reference. */
  async stop(reason: string): Promise<void> {
    await this.stage?.stop();
    this.stage = undefined;
    await this.rootConfigStage?.stop();
    this.rootConfigStage = undefined;
  }
}

/** Rejects copied Codex homes that escape the run root or contain symlinks. */
function assertRunCodexHomeIsContained(allowMissingHome: boolean): void {
  const scope = currentRunScope();
  const scoutRoot = resolve(scope.scoutRoot);
  const runRoot = resolve(scope.runRoot);
  const { codexHome: codexRoot, codexSessionsRoot: sessionsRoot } = runPaths(runRoot);
  const requireDirectoryChain = (
    root: string,
    target: string,
    label: string,
    allowMissing = false,
  ): boolean => {
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
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new Error(`Cannot inspect ${label} component ${current}.`, { cause: error });
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symlinked ${label} component: ${current}.`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Expected ${label} component to be a directory: ${current}.`);
      }
    }
    return true;
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

  requireDirectoryChain(scoutRoot, runRoot, "run root");
  const scoutRootReal = realpathSync(scoutRoot);
  const runRootReal = realpathSync(runRoot);
  assertInside(runRootReal, scoutRootReal, "Run root");
  if (!requireDirectoryChain(runRoot, codexRoot, "Codex home", allowMissingHome)) return;
  const codexRootReal = realpathSync(codexRoot);
  assertInside(codexRootReal, runRootReal, "Codex home");

  let sessionsStat: Stats | undefined;
  try {
    sessionsStat = lstatSync(sessionsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot inspect Codex sessions root ${sessionsRoot}.`, { cause: error });
    }
  }
  if (sessionsStat?.isSymbolicLink()) {
    throw new Error(`Refusing symlinked Codex home component: ${sessionsRoot}.`);
  }
  if (sessionsStat && !sessionsStat.isDirectory()) {
    throw new Error(`Expected Codex home component to be a directory: ${sessionsRoot}.`);
  }
  if (sessionsStat) {
    assertInside(realpathSync(sessionsRoot), codexRootReal, "Codex sessions root");
  }
  requireRegularFileIfPresent(join(codexRoot, "config.toml"), "Codex config");
}

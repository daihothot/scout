import {
  installRunScope,
  type RunScope,
} from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Installs the process-local RunScope before dependent stages start. */
export class RunScopeStage implements RunStage {
  readonly id = "run_scope";
  private installedScope?: RunScope;
  private releaseScope?: () => void;
  private stopped = false;

  constructor(private readonly runScope: RunScope) {}

  get scope(): RunScope {
    if (!this.installedScope) throw new Error("Run scope stage has not completed.");
    return this.installedScope;
  }

  get scopeCreated(): boolean {
    return this.installedScope !== undefined;
  }

  async start(): Promise<void> {
    try {
      this.releaseScope = installRunScope(this.runScope);
    } catch (error) {
      this.runScope.dispose();
      throw error;
    }
    this.installedScope = this.runScope;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const release = this.releaseScope;
    try {
      release?.();
    } finally {
      this.releaseScope = undefined;
    }
  }
}

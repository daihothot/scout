import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Starts the run's validation domain and rolls it back if startup fails. */
export class DomainStage implements RunStage {
  readonly id = "domain";
  private started = false;

  async start(): Promise<void> {
    const domain = currentRunScope().domain;
    try {
      await domain.start?.();
      this.started = true;
    } catch (error) {
      await domain.stop?.();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await currentRunScope().domain.stop?.();
  }
}

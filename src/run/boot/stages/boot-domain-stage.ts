import { currentRunScope } from "../../run-scope.js";
import type { BootStage } from "../boot-stage.js";

export class BootDomainStage implements BootStage {
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

import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";

export class RestoreDomainStage implements RunStage {
  readonly id = "restore_domain";

  async start(): Promise<void> {
    await currentRunScope().domain.restore?.();
  }
}

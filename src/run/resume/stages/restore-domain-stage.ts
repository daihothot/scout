import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";

/** Restores domain-owned state after the shared run scope has been reattached. */
export class RestoreDomainStage implements RunStage {
  readonly id = "restore_domain";

  /** Delegates restoration to the domain owner without adding resume policy. */
  async start(): Promise<void> {
    await currentRunScope().domain.restore?.();
  }
}

import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";

/** Restores domain-owned state after the shared run scope has been reattached. */
export class RestoreDomainStage implements RunStage {
  readonly id = "restore_domain";

  /** Delegates restoration to the domain owner without adding resume policy. */
  async start(): Promise<void> {
    const scope = currentRunScope();
    const flow = scope.workflow.flowSnapshot();
    for (const domain of scope.domainRegistry.list()) {
      await domain.restore?.(flow);
    }
  }
}

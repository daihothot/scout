import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";

/** Persists Run identity before Workflow prepares its own initial journal. */
export class InitializeRunStage implements RunStage {
  readonly id = "initialize_run";

  async start(): Promise<void> {
    const scope = currentRunScope();
    const createdAt = new Date().toISOString();
    scope.manifestStore.create({
      runId: scope.runId,
      scoutRoot: scope.scoutRoot,
      createdAt,
      checkpointSeq: 0,
    });
  }
}

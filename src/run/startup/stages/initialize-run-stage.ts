import { RunEvents } from "../../events/index.js";
import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";

export class InitializeRunStage implements RunStage {
  readonly id = "initialize_run";

  async start(): Promise<void> {
    const scope = currentRunScope();
    const createdAt = new Date().toISOString();
    scope.eventBus.publish(RunEvents.run.created, {
      runId: scope.runId,
      repoRoot: scope.repoRoot,
      createdAt,
    }, {
      occurredAt: createdAt,
    });
    scope.manifestStore.create({
      runId: scope.runId,
      repoRoot: scope.repoRoot,
      createdAt,
      checkpointSeq: scope.journal.lastSeq,
    });
  }
}

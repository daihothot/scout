import { RunEvents } from "../../events/index.js";
import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";

/** Emits creation identity and writes the initial run manifest. */
export class InitializeRunStage implements RunStage {
  readonly id = "initialize_run";

  async start(): Promise<void> {
    const scope = currentRunScope();
    const createdAt = new Date().toISOString();
    scope.eventBus.publish(RunEvents.run.created, {
      runId: scope.runId,
      scoutRoot: scope.scoutRoot,
      createdAt,
    }, {
      occurredAt: createdAt,
    });
    scope.scheduler.initialize();
    scope.manifestStore.create({
      runId: scope.runId,
      scoutRoot: scope.scoutRoot,
      createdAt,
      checkpointSeq: scope.journal.lastSeq,
    });
  }
}

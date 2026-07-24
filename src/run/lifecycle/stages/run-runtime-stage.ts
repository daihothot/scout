import { RunEvents } from "../../events/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

export class RunRuntimeStage implements RunStage {
  readonly id = "run_runtime";

  constructor(private readonly mode: "start" | "resume") {}

  async start(): Promise<void> {
    const scope = currentRunScope();
    const attachedAt = new Date().toISOString();
    scope.eventBus.publish(RunEvents.runtime.attached, {
      mode: this.mode,
      attachedAt,
      processId: process.pid,
    }, {
      occurredAt: attachedAt,
    });
    scope.manifestStore.update((manifest) => ({
      ...manifest,
      runtime: {
        status: "attached",
        mode: this.mode,
        processId: process.pid,
      },
      checkpointSeq: scope.journal.lastSeq,
    }));
  }

  async stop(reason: string): Promise<void> {
    const scope = currentRunScope();
    const stoppedAt = new Date().toISOString();
    const interrupted = reason === "startup_failed";
    if (interrupted) {
      scope.eventBus.publish(RunEvents.runtime.interrupted, {
        reason,
        interruptedAt: stoppedAt,
      }, {
        occurredAt: stoppedAt,
      });
    } else {
      scope.eventBus.publish(RunEvents.runtime.detached, {
        reason,
        detachedAt: stoppedAt,
      }, {
        occurredAt: stoppedAt,
      });
    }
    scope.manifestStore.update((manifest) => ({
      ...manifest,
      runtime: { status: interrupted ? "interrupted" : "detached", reason },
      checkpointSeq: scope.journal.lastSeq,
    }));
  }
}

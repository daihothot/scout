import { RunEvents } from "../../events/index.js";
import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";

/** Reconciles only the previous Run attachment; Agent interruptions belong to Agent recovery. */
export class RecordResumeInterruptionsStage implements RunStage {
  readonly id = "record_resume_interruptions";
  async start(): Promise<void> {
    const scope = currentRunScope();
    if (!scope.workflow.snapshot()) return;
    const previous = [...scope.workflow.readEvents()].reverse().find((event) =>
      RunEvents.runtime.attached.is(event) || RunEvents.runtime.ready.is(event)
      || RunEvents.runtime.detached.is(event) || RunEvents.runtime.interrupted.is(event));
    if (!previous || (!RunEvents.runtime.attached.is(previous) && !RunEvents.runtime.ready.is(previous))) return;
    const interruptedAt = new Date().toISOString();
    await scope.eventBus.publishAndWait(RunEvents.runtime.interrupted,
      { reason: "previous_runtime_missing_detach", interruptedAt }, { occurredAt: interruptedAt });
  }
}

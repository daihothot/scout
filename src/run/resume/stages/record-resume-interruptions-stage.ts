import { AgentEvents } from "../../../agent/events/index.js";
import { AgentStepStatuses } from "../../../agent/step/types.js";
import { RunEvents } from "../../events/index.js";
import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";
import { projectRun } from "../projection/index.js";

/**
 * Converts evidence of an unclean previous shutdown into journal events.
 * It marks incomplete turns and task steps interrupted and records a missing
 * runtime detach; it does not restart agents or decide how projected work is
 * resumed.
 */
export class RecordResumeInterruptionsStage implements RunStage {
  readonly id = "record_resume_interruptions";

  /** Reconciles prior runtime, turn, and step state before other restoration. */
  async start(): Promise<void> {
    this.recordPreviousRuntimeInterruption();
    const scope = currentRunScope();
    let projection = projectRun(scope.journal.readAll());
    for (const turn of projection.turns.filter((candidate) => !candidate.completedAt)) {
      const interruptedAt = new Date().toISOString();
      scope.eventBus.publish(AgentEvents.turn.interrupted, {
        invocationId: turn.invocationId,
        agentId: turn.agentId,
        role: turn.role,
        taskId: turn.taskId,
        threadId: turn.threadId,
        reason: "previous_runtime_ended_before_turn_completion",
        interruptedAt,
      }, {
        occurredAt: interruptedAt,
      });
    }

    projection = projectRun(scope.journal.readAll());
    const interruptionReason = "previous_runtime_ended_before_step_completion";
    for (const step of projection.steps) {
      if (step.status !== AgentStepStatuses.Running) continue;
      const interruptedAt = new Date().toISOString();
      const interruptedStep = {
        ...step,
        status: AgentStepStatuses.Interrupted,
        finishedAt: interruptedAt,
        durationMs: Math.max(
          0,
          new Date(interruptedAt).getTime() - new Date(step.startedAt).getTime(),
        ),
        error: interruptionReason,
        updatedAt: interruptedAt,
      };
      scope.eventBus.publish(
        AgentEvents.step.interrupted,
        interruptedStep,
        { occurredAt: interruptedAt },
      );
      if (!step.taskId) continue;
      const task = projection.tasks.find((candidate) => candidate.taskId === step.taskId);
      if (!task) throw new Error(`Interrupted Agent step ${step.stepId} references unknown task ${step.taskId}.`);
      scope.eventBus.publish(
        AgentEvents.task.stepInterrupted,
        { ...task, updatedAt: interruptedAt },
        { occurredAt: interruptedAt },
      );
    }

    projection = projectRun(scope.journal.readAll());
    if (projection.checkpointSeq !== scope.journal.lastSeq) {
      throw new Error(`Run projection did not consume journal tail for ${projection.runId}.`);
    }
  }

  /** Emits one runtime interruption only when the prior runtime lacks a detach. */
  private recordPreviousRuntimeInterruption(): void {
    const scope = currentRunScope();
    const runtimeEvent = [...scope.journal.readAll()].reverse().find((event) =>
      RunEvents.runtime.attached.is(event)
      || RunEvents.runtime.ready.is(event)
      || RunEvents.runtime.detached.is(event)
      || RunEvents.runtime.interrupted.is(event)
    );
    if (
      !runtimeEvent
      || (
        !RunEvents.runtime.attached.is(runtimeEvent)
        && !RunEvents.runtime.ready.is(runtimeEvent)
      )
    ) {
      return;
    }
    const interruptedAt = new Date().toISOString();
    scope.eventBus.publish(RunEvents.runtime.interrupted, {
      reason: "previous_runtime_missing_detach",
      interruptedAt,
    }, {
      occurredAt: interruptedAt,
    });
  }
}

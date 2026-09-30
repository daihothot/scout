import type { AgentTaskState } from "../../../agent/task/types.js";
import { AgentEvents } from "../../../agent/events/index.js";
import type { RecordEvent } from "../../../core/record/index.js";

/** Historical result retained after its Worker releases the runtime binding. */
export interface ProjectedReleasedTask {
  task: AgentTaskState;
  releasedAt: string;
}

/**
 * Applies one task-domain journal event to the maps owned by `projectRun`.
 * Returns whether the event belongs to task projection; release detaches the
 * task without changing its result. Step lifecycle facts are projected separately.
 */
export function applyTaskRecordEvent(
  tasks: Map<string, AgentTaskState>,
  releasedTasks: Map<string, ProjectedReleasedTask>,
  event: RecordEvent,
): boolean {
  const requireTaskPhase = (task: AgentTaskState): void => {
    if (typeof task.phase !== "string" || task.phase.length === 0) {
      throw new Error(`Task ${task.taskId} is missing its Workflow Phase.`);
    }
  };
  if (
    AgentEvents.task.assigned.is(event)
    || AgentEvents.task.stepStarted.is(event)
    || AgentEvents.task.stepCompleted.is(event)
    || AgentEvents.task.stepInterrupted.is(event)
    || AgentEvents.task.done.is(event)
    || AgentEvents.task.failed.is(event)
    || AgentEvents.task.stopped.is(event)
  ) {
    requireTaskPhase(event.payload);
    tasks.set(event.payload.taskId, structuredClone(event.payload));
    return true;
  }
  if (AgentEvents.task.outcomeSubmitted.is(event)) {
    requireTaskPhase(event.payload.task);
    tasks.set(event.payload.task.taskId, structuredClone(event.payload.task));
    return true;
  }
  if (AgentEvents.task.dispositionRecorded.is(event)) {
    const task = event.payload.task;
    requireTaskPhase(task);
    tasks.set(task.taskId, structuredClone(task));
    return true;
  }
  if (AgentEvents.task.released.is(event)) {
    requireTaskPhase(event.payload);
    tasks.delete(event.payload.taskId);
    releasedTasks.set(event.payload.taskId, {
      task: structuredClone(event.payload),
      releasedAt: event.occurredAt,
    });
    return true;
  }
  return false;
}

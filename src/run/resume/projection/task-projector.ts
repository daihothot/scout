import type { AgentTaskState } from "../../../agent/task/types.js";
import { AgentEvents } from "../../../agent/events/index.js";
import { sameAgentTaskDisposition } from "../../../agent/task/agent-task-store.js";
import type { RunJournalEvent } from "../../journal/index.js";

export interface ProjectedArchivedTask {
  task: AgentTaskState;
  archivedAt: string;
}

export function applyTaskJournalEvent(
  tasks: Map<string, AgentTaskState>,
  archivedTasks: Map<string, ProjectedArchivedTask>,
  event: RunJournalEvent,
): boolean {
  if (
    AgentEvents.task.assigned.is(event)
    || AgentEvents.task.stepStarted.is(event)
    || AgentEvents.task.stepCompleted.is(event)
    || AgentEvents.task.stepInterrupted.is(event)
    || AgentEvents.task.done.is(event)
    || AgentEvents.task.failed.is(event)
    || AgentEvents.task.stopped.is(event)
  ) {
    tasks.set(event.payload.taskId, structuredClone(event.payload));
    return true;
  }
  if (AgentEvents.task.outcomeSubmitted.is(event)) {
    tasks.set(event.payload.task.taskId, structuredClone(event.payload.task));
    return true;
  }
  if (AgentEvents.task.dispositionRecorded.is(event)) {
    const task = event.payload.task;
    const recorded = task.steps
      ?.find((step) => step.stepId === event.payload.disposition.stepId)
      ?.disposition;
    if (
      !recorded
      || recorded.timestamp !== event.payload.disposition.timestamp
      || !sameAgentTaskDisposition(recorded, event.payload.disposition)
    ) {
      throw new Error(
        `Task disposition event does not match step ${event.payload.disposition.stepId}.`,
      );
    }
    tasks.set(task.taskId, structuredClone(task));
    return true;
  }
  if (AgentEvents.task.archived.is(event)) {
    tasks.delete(event.payload.taskId);
    archivedTasks.set(event.payload.taskId, {
      task: structuredClone(event.payload),
      archivedAt: event.occurredAt,
    });
    return true;
  }
  return false;
}

import { AgentEvents } from "../../../agent/events/index.js";
import { WorkerAgent } from "../../../agent/roles/worker-agent.js";
import { AgentTaskStatuses } from "../../../agent/task/types.js";
import { ScoutAgentRoles } from "../../../agent/thread/types.js";
import type { ScoutEvent } from "../../../core/events/index.js";
import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";
import { projectRun, type RunProjection } from "../projection/index.js";

export class RestoreTasksStage implements RunStage {
  readonly id = "restore_tasks";

  async start(): Promise<void> {
    const scope = currentRunScope();
    const projection = projectRun(scope.journal.readAll());
    const allTasks = [
      ...projection.tasks,
      ...projection.archivedTasks.map(({ task }) => task),
    ];
    for (const role of [
      ScoutAgentRoles.Researcher,
      ScoutAgentRoles.Verifier,
      ScoutAgentRoles.Validator,
    ] as const) {
      const worker = scope.agentRegistry.resolveAgent(role);
      if (!(worker instanceof WorkerAgent)) {
        throw new Error(`Restored agent ${role} is not a Worker agent.`);
      }
      const roleTasks = allTasks.filter((task) => task.agentId === worker.agentId);
      const maxTaskSequence = Math.max(0, ...roleTasks.map((task) => task.taskSequence));
      const unarchivedTasks = projection.tasks.filter((task) =>
        task.agentId === worker.agentId
      );
      if (unarchivedTasks.length > 1) {
        throw new Error(`Worker agent ${worker.agentId} has multiple unarchived tasks.`);
      }
      const boundTask = unarchivedTasks[0];
      if (boundTask) {
        worker.restoreTask({ task: boundTask, maxTaskSequence });
      } else {
        worker.restoreTaskSequence(maxTaskSequence);
      }
    }

    for (const task of projection.tasks) {
      await scope.interactionPort.publishTaskEvent(restoredTaskEvent(task));
    }
    for (const archived of projection.archivedTasks) {
      await scope.interactionPort.publishTaskEvent({
        id: `restore-archived-${archived.task.taskId}`,
        key: AgentEvents.task.archived,
        payload: archived.task,
        occurredAt: archived.archivedAt,
      });
    }
  }
}

function restoredTaskEvent(task: RunProjection["tasks"][number]): ScoutEvent {
  const key = task.status === AgentTaskStatuses.Done
    ? AgentEvents.task.done
    : task.status === AgentTaskStatuses.Failed
      ? AgentEvents.task.failed
      : task.status === AgentTaskStatuses.Stopped
        ? AgentEvents.task.stopped
        : AgentEvents.task.assigned;
  return {
    id: `restore-task-${task.taskId}`,
    key,
    payload: task,
    occurredAt: task.updatedAt,
  };
}

import { AgentEvents } from "../../../agent/events/index.js";
import { WorkerAgent } from "../../../agent/roles/worker-agent.js";
import {
  listWorkerRoles,
  resolveSynthesisRole,
} from "../../../core/workflow/index.js";
import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";
import { projectRun } from "../projection/index.js";

/**
 * Rehydrates worker task stores and republishes projected task facts to the
 * interaction boundary. It restores sequence/state only; resumed execution is
 * activated later by `InjectResumeContextStage`.
 */
export class RestoreTasksStage implements RunStage {
  readonly id = "restore_tasks";

  /** Restores active and archived task projections for every worker role. */
  async start(): Promise<void> {
    const scope = currentRunScope();
    const graphState = scope.scheduler.snapshot();
    const projection = projectRun(
      scope.journal.readAll(),
      resolveSynthesisRole(graphState).name,
      scope.domain.journal,
    );
    const allTasks = [
      ...projection.tasks,
      ...projection.archivedTasks.map(({ task }) => task),
    ];
    const workerRoles = listWorkerRoles(graphState).map((role) => role.name);
    for (const role of workerRoles) {
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
      await scope.interactionPort.restoreTaskSnapshot(task);
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

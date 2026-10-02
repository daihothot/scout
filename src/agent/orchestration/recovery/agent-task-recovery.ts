import { AgentEvents } from "../../../agent/events/index.js";
import { WorkerAgent } from "../../../agent/roles/worker-agent.js";
import {
  listWorkerRoles,
  resolveSynthesisRole,
} from "../../../core/workflow/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type { AgentWorkflowData } from "../projector/agent-workflow-projector.js";

/**
 * Rehydrates worker task stores and republishes projected task facts to the
 * interaction boundary. It restores sequence/state only; resumed execution is
 * activated later by `InjectResumeContextStage`.
 */
export class AgentTaskRecovery {

  /** Restores bound tasks and historical results without rebinding released tasks. */
  async restore(projection: AgentWorkflowData): Promise<void> {
    const scope = currentRunScope();
    const graphData = scope.workflow.graph.snapshot();
    const allTasks = [
      ...projection.tasks,
      ...projection.releasedTasks.map(({ task }) => task),
    ];
    const workerRoles = listWorkerRoles(graphData).map((role) => role.name);
    for (const role of workerRoles) {
      const worker = scope.agentRegistry.resolveAgent(role);
      if (!(worker instanceof WorkerAgent)) {
        throw new Error(`Restored agent ${role} is not a Worker agent.`);
      }
      const roleTasks = allTasks.filter((task) => task.agentId === worker.agentId);
      const maxTaskSequence = Math.max(0, ...roleTasks.map((task) => task.taskSequence));
      const unreleasedTasks = projection.tasks.filter((task) =>
        task.agentId === worker.agentId
      );
      if (unreleasedTasks.length > 1) {
        throw new Error(`Worker agent ${worker.agentId} has multiple bound tasks.`);
      }
      const boundTask = unreleasedTasks[0];
      if (boundTask) {
        worker.restoreTask({ task: boundTask, maxTaskSequence });
      } else {
        worker.restoreTaskSequence(maxTaskSequence);
      }
    }

    for (const task of projection.tasks) {
      await scope.interactionPort.restoreTaskSnapshot(task);
    }
    for (const released of projection.releasedTasks) {
      await scope.interactionPort.publishTaskEvent({
        id: `restore-released-${released.task.taskId}`,
        key: AgentEvents.task.released,
        payload: released.task,
        occurredAt: released.releasedAt,
      });
    }
  }
}

import { AgentEvents } from "../events/index.js";
import type {
  AppServerPlanState,
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import {
  AgentTaskStore,
  cloneAgentTaskState,
} from "../task/agent-task-store.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { WorkerAgent } from "../roles/worker-agent.js";
import type {
  AgentTaskState,
} from "../task/types.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";

/**
 * Applies agent task commands and app-server plan observations to the shared
 * task store. It delegates execution to the owning runner and does not decide
 * how a runner schedules its turns.
 */
export class AgentTaskBackend {
  private readonly registry: RunScope["agentRegistry"];
  private readonly taskStore: AgentTaskStore;
  private readonly eventBus: RunScope["eventBus"];

  constructor() {
    const scope = currentRunScope();
    this.registry = scope.agentRegistry;
    this.taskStore = scope.taskStore;
    this.eventBus = scope.eventBus;
  }

  async stopAgentTask(
    target: string,
    reason = "任务已被 Coordinator 停止。",
  ): Promise<AgentTaskState> {
    const resolved = this.resolveTaskTarget(target);
    const runner = resolved.agent.runner;
    if (!runner) throw new Error(`Agent ${resolved.agent.agentId} has no runner for task ${resolved.taskId}.`);
    const task = await runner.stopTask(resolved.taskId, reason);
    return task;
  }

  getAgentTask(taskId: string): AgentTaskState {
    const task = this.taskStore.getTask(taskId);
    if (!task) throw new Error(`Unknown agent task: ${taskId}`);
    return task;
  }

  async archiveAgentTask(taskId: string): Promise<AgentTaskState> {
    const task = this.getAgentTask(taskId);
    const agent = this.registry.resolveAgent(task.agentId);
    if (!(agent instanceof WorkerAgent)) {
      throw new Error(`Task ${taskId} is not owned by a Worker agent.`);
    }
    return agent.archiveTask(taskId);
  }

  hasRunningAgentTasks(): boolean {
    return this.taskStore.hasRunningTasks();
  }

  hasOpenAgentTasks(): boolean {
    return this.taskStore.hasOpenTasks();
  }

  handleAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolver: AgentTaskTimelineResolver,
  ): void {
    const activeTask = this.taskStore.findActiveTaskForAgent(agent.agentId);
    switch (entry.stream) {
      case "plan": {
        if (entry.kind !== "plan_updated" || !activeTask) return;
        const resolved = resolver(entry);
        const turnId = resolved.plan?.turnId ?? entry.turnId;
        if (resolved.plan && turnId) {
          this.applyPlanUpdate(activeTask, {
            ...resolved.plan,
            turnId,
          });
        }
        return;
      }
      case "state":
      case "item":
      case "lifecycle":
      case "request":
        return;
    }
  }

  private resolveTaskTarget(target: string): { agent: ScoutAgent; taskId: string } {
    const task = this.taskStore.getTask(target);
    if (task) {
      return {
        agent: this.registry.resolveAgent(task.agentId),
        taskId: task.taskId,
      };
    }
    const agent = this.registry.resolveAgent(target);
    const active = this.taskStore.findActiveTaskForAgent(agent.agentId);
    if (!active) {
      throw new Error(`Agent ${agent.agentId} has no active task.`);
    }
    return {
      agent,
      taskId: active.taskId,
    };
  }

  private applyPlanUpdate(
    task: AgentTaskState,
    plan: AppServerPlanState,
  ): AgentTaskState {
    const planRecords = task.planRecords ?? [];
    const existingTurnIndex = planRecords.findIndex((record) => record.turnId === plan.turnId);
    const updated: AgentTaskState = {
      ...task,
      plan,
      planRecords: existingTurnIndex < 0
        ? [...planRecords, plan]
        : planRecords.map((record, index) => index === existingTurnIndex ? plan : record),
      updatedAt: new Date().toISOString(),
    };
    const stored = this.taskStore.updateTask(updated.taskId, () => updated);
    this.eventBus.publish(AgentEvents.task.planUpdated, cloneAgentTaskState(stored));
    return stored;
  }

}

/** Resolves an app-server timeline entry to its complete task-oriented view. */
export type AgentTaskTimelineResolver = (
  entry: AppServerTimelineEntry,
) => AppServerResolvedTimelineEntry;

/** Returns a detached task snapshot suitable for event or persistence consumers. */
export function cloneTask(task: AgentTaskState): AgentTaskState {
  return cloneAgentTaskState(task);
}

import type { AgentTaskStore } from "../task/agent-task-store.js";
import {
  AgentTaskStatuses,
  type AgentTaskState,
  type AssignAgentTaskInput,
  type SendAgentMessageInput,
} from "../task/types.js";
import type { AgentTaskNotAssignedEventPayload } from "../task/task-events.js";
import { Result } from "../../core/result.js";
import { AgentEvents } from "../events/index.js";
import { ScoutAgent, type ScoutAgentOptions } from "../core/scout-agent.js";
import { ScoutAgentRoles, type AgentThreadSpec } from "../thread/types.js";
import { WorkerRunner } from "../runner/worker/worker-runner.js";
import { agent } from "../context/agent-attachments.js";

export abstract class WorkerAgent extends ScoutAgent {
  declare runner: WorkerRunner | undefined;
  private readonly workerTaskStore: AgentTaskStore;
  private taskSequence = 0;

  constructor(options: ScoutAgentOptions & { spec: AgentThreadSpec }) {
    super(options);
    this.workerTaskStore = this.runScope.taskStore;
  }

  assignTask(input: AssignAgentTaskInput): Result<AgentTaskState, AgentTaskNotAssignedEventPayload> {
    if (this.runner) {
      const activeTask = this.runner.snapshot().activeTask;
      if (!activeTask) {
        throw new Error(`Worker agent ${this.agentId} has a runner without a bound task.`);
      }
      const reason = "The worker agent already has a task that has not been archived.";
      const rejection = {
        agentId: this.agentId,
        role: this.role,
        activeTaskId: activeTask.taskId,
        requestedDescription: input.description,
        reason,
      } satisfies AgentTaskNotAssignedEventPayload;
      this.eventBus.publish(AgentEvents.task.notAssigned, rejection);
      return Result.err(rejection);
    }

    const taskSequence = this.taskSequence + 1;
    const runner = this.createWorkerRunner(input, taskSequence);
    const task = runner.snapshot().activeTask;
    if (!task) {
      throw new Error(`Worker agent ${this.agentId} failed to initialize assigned task.`);
    }
    this.taskSequence = taskSequence;
    this.runner = runner;
    return Result.ok(task);
  }

  sendMessage(input: SendAgentMessageInput): Result<void, string> {
    const runner = this.runner;
    if (!runner) {
      return Result.err(`Worker agent ${this.agentId} has no task runner to receive a message.`);
    }
    runner.queueMessage(input);
    return Result.ok(undefined);
  }

  submitTask(outcome: string): Result<AgentTaskState, string> {
    const runner = this.runner;
    const task = runner?.snapshot().activeTask;
    if (!runner || !task) {
      return Result.err(`Worker agent ${this.agentId} has no active task to submit.`);
    }
    if (task.status !== AgentTaskStatuses.Running) {
      return Result.err(`Worker task ${task.taskId} cannot be submitted from status ${task.status}.`);
    }
    try {
      return Result.ok(runner.submitTask(outcome));
    } catch (error) {
      return Result.err(error instanceof Error ? error.message : String(error));
    }
  }

  async archiveTask(taskId: string): Promise<AgentTaskState> {
    const runner = this.runner;
    if (!runner) {
      throw new Error(`Worker agent ${this.agentId} has no task runner to archive.`);
    }
    const task = runner.snapshot().activeTask;
    if (!task || task.taskId !== taskId) {
      throw new Error(`Worker agent ${this.agentId} does not own task ${taskId}.`);
    }
    const archived = await runner.archiveTask(taskId);
    if (this.runner === runner) {
      this.runner = undefined;
    }
    return archived;
  }

  private createWorkerRunner(taskInput: AssignAgentTaskInput, taskSequence: number): WorkerRunner {
    const worker = this;
    return new WorkerRunner({
      store: this.workerTaskStore,
      eventBus: this.eventBus,
      taskInput,
      taskSequence,
      host: {
        get agentId() {
          return worker.agentId;
        },
        get role() {
          return worker.role;
        },
        get spec() {
          return worker.spec;
        },
        runTurn: (turnInput) => worker.runTurn(turnInput),
        deliverTaskOutcome: (outcome) => {
          const coordinator = worker.registry.listAgents().find((candidate) =>
            candidate.role === ScoutAgentRoles.Coordinator
          );
          if (!coordinator) {
            throw new Error(`Worker agent ${worker.agentId} cannot find the Coordinator agent.`);
          }
          const delivered = coordinator.sendMessage({
            message: agent.turn.task_outcome(outcome),
          });
          if (!delivered.ok) throw new Error(delivered.error);
        },
      },
    });
  }
}

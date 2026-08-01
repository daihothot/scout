import {
  type AgentTaskState,
  type AssignAgentTaskInput,
  type SendAgentMessageInput,
} from "../task/types.js";
import type { AgentTaskNotAssignedEventPayload } from "../task/task-events.js";
import { Result } from "../../core/result.js";
import { AgentEvents } from "../events/index.js";
import { ScoutAgent, type ScoutAgentOptions } from "../core/scout-agent.js";
import { ScoutAgentRoles, type AgentThreadSpec } from "../thread/types.js";
import {
  WorkerRunner,
  type WorkerHumanInputDisposition,
  type WorkerLifecycleToolCall,
  type WorkerTaskSubmission,
} from "../runner/worker/worker-runner.js";
import { agent } from "../context/agent-attachments.js";
import type { AgentMessage } from "../message/types.js";

export abstract class WorkerAgent extends ScoutAgent {
  declare runner: WorkerRunner | undefined;
  private taskSequence = 0;

  constructor(options: ScoutAgentOptions & { spec: AgentThreadSpec }) {
    super(options);
  }

  async assignTask(
    input: AssignAgentTaskInput,
  ): Promise<Result<AgentTaskState, AgentTaskNotAssignedEventPayload>> {
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
    const runner = this.createWorkerRunner({ taskSequence });
    const task = await runner.assignTask(input);
    this.taskSequence = taskSequence;
    this.runner = runner;
    return Result.ok(task);
  }

  async sendMessage(input: SendAgentMessageInput): Promise<Result<void, string>> {
    const runner = this.runner;
    if (!runner) {
      return Result.err(`Worker agent ${this.agentId} has no task runner to receive a message.`);
    }
    await runner.queueMessage(input);
    return Result.ok(undefined);
  }

  async submitTask(input: WorkerTaskSubmission): Promise<Result<AgentTaskState, string>> {
    const runner = this.runner;
    const task = runner?.snapshot().activeTask;
    if (!runner || !task) {
      return Result.err(`Worker agent ${this.agentId} has no active task to submit.`);
    }
    try {
      return Result.ok(await runner.submitTask(input));
    } catch (error) {
      return Result.err(error instanceof Error ? error.message : String(error));
    }
  }

  beginHumanInput(
    input: WorkerLifecycleToolCall & { request: string },
  ): Result<AgentTaskState, string> {
    const runner = this.runner;
    if (!runner) {
      return Result.err(`Worker agent ${this.agentId} has no active task for RequestHumanInput.`);
    }
    try {
      return Result.ok(runner.beginHumanInput(input));
    } catch (error) {
      return Result.err(error instanceof Error ? error.message : String(error));
    }
  }

  async completeHumanInput(
    input: WorkerHumanInputDisposition,
  ): Promise<Result<AgentTaskState, string>> {
    const runner = this.runner;
    if (!runner) {
      return Result.err(`Worker agent ${this.agentId} has no active task for RequestHumanInput.`);
    }
    try {
      return Result.ok(await runner.completeHumanInput(input));
    } catch (error) {
      return Result.err(error instanceof Error ? error.message : String(error));
    }
  }

  abortHumanInput(input: WorkerLifecycleToolCall & { request: string }): void {
    this.runner?.abortHumanInput(input);
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

  restoreTask(input: {
    task: AgentTaskState;
    maxTaskSequence: number;
  }): void {
    if (this.runner) {
      throw new Error(`Worker agent ${this.agentId} already has a runner.`);
    }
    this.taskSequence = Math.max(this.taskSequence, input.maxTaskSequence);
    this.runner = this.createWorkerRunner({
      taskSequence: input.task.taskSequence,
      restoredTask: input.task,
    });
  }

  restoreState(input: {
    acceptedMessages: AgentMessage[];
    pendingMessages: AgentMessage[];
    resumeContext: string;
    resumeImmediately: boolean;
  }): void {
    if (!this.runner) throw new Error(`Worker agent ${this.agentId} has no restored runner.`);
    this.runner.restoreState(input);
  }

  restoreTaskSequence(taskSequence: number): void {
    if (this.runner) {
      throw new Error(`Worker agent ${this.agentId} cannot change task sequence with an active runner.`);
    }
    this.taskSequence = Math.max(this.taskSequence, taskSequence);
  }

  activateRestoredTask(): void {
    if (!this.runner) throw new Error(`Worker agent ${this.agentId} has no restored runner.`);
    this.runner.activateRestoredTask();
  }

  private createWorkerRunner(input: {
    taskSequence: number;
    restoredTask?: AgentTaskState;
  }): WorkerRunner {
    const worker = this;
    return new WorkerRunner({
      ...input,
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
        deliverTaskOutcome: async (outcome) => {
          const coordinator = worker.registry.listAgents().find((candidate) =>
            candidate.role === ScoutAgentRoles.Coordinator
          );
          if (!coordinator) {
            throw new Error(`Worker agent ${worker.agentId} cannot find the Coordinator agent.`);
          }
          const delivered = await coordinator.sendMessage({
            message: agent.turn.task_outcome(outcome),
          });
          if (!delivered.ok) throw new Error(delivered.error);
        },
        deliverTaskProtocolFailure: async (message) => {
          const coordinator = worker.registry.listAgents().find((candidate) =>
            candidate.role === ScoutAgentRoles.Coordinator
          );
          if (!coordinator) {
            throw new Error(`Worker agent ${worker.agentId} cannot find the Coordinator agent.`);
          }
          const delivered = await coordinator.sendMessage({
            message: agent.turn.message(message),
          });
          if (!delivered.ok) throw new Error(delivered.error);
        },
      },
    });
  }
}

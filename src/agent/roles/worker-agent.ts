import {
  type AgentTaskState,
  type AssignAgentTaskInput,
  type SendAgentMessageInput,
} from "../task/types.js";
import type { AgentTaskNotAssignedEventPayload } from "../task/task-events.js";
import { Result } from "../../core/result.js";
import { AgentEvents } from "../events/index.js";
import { ScoutAgent, type ScoutAgentOptions } from "../core/scout-agent.js";
import type { AgentThreadSpec } from "../thread/types.js";
import { CoordinatorAgent } from "./coordinator-agent.js";
import {
  WorkerRunner,
} from "../runner/worker/worker-runner.js";
import {
  TaskRunner,
  type TaskStepPreparation,
} from "../runner/task/task-runner.js";
import { agent } from "../context/agent-attachments.js";
import type { AgentMessage } from "../message/types.js";
import { AgenticLoop } from "../core/agentic-loop.js";

/**
 * Base implementation for role-specific workers. It owns one reusable Step
 * runner and zero or one unarchived TaskRunner.
 */
export class WorkerAgent extends ScoutAgent {
  readonly stepRunner: WorkerRunner;
  private readonly loop: AgenticLoop<TaskStepPreparation>;
  private currentTaskRunner?: TaskRunner;
  private taskSequence = 0;
  private archivingTask = false;

  constructor(options: ScoutAgentOptions & { spec: AgentThreadSpec }) {
    super(options);
    const worker = this;
    this.stepRunner = new WorkerRunner({
      host: {
        get agentId() {
          return worker.agentId;
        },
        runTurn: (turnInput) => worker.runTurn(turnInput),
      },
    });
    this.loop = new AgenticLoop({
      agentId: this.agentId,
      takeTick: () => this.currentTaskRunner?.prepareStep(this.pendingMessagesSnapshot()),
      runTick: (preparation) => this.runWorkerTick(preparation),
      isStopped: () => this.isStopping || this.archivingTask,
      onError: (error) => this.currentTaskRunner?.failActiveTask(error),
    });
  }

  get taskRunner(): TaskRunner | undefined {
    return this.currentTaskRunner;
  }

  async assignTask(
    input: AssignAgentTaskInput,
  ): Promise<Result<AgentTaskState, AgentTaskNotAssignedEventPayload>> {
    if (this.isStopping) {
      throw new Error(`Worker agent ${this.agentId} is stopping and cannot accept another task.`);
    }
    if (this.currentTaskRunner) {
      const activeTask = this.currentTaskRunner.snapshot().activeTask;
      if (!activeTask) {
        throw new Error(`Worker agent ${this.agentId} has a TaskRunner without a bound task.`);
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
    const runner = this.createTaskRunner({ taskSequence });
    this.currentTaskRunner = runner;
    try {
      const task = await runner.assignTask(input);
      this.taskSequence = taskSequence;
      queueMicrotask(() => this.loop.schedule());
      return Result.ok(task);
    } catch (error) {
      if (this.currentTaskRunner === runner) this.currentTaskRunner = undefined;
      throw error;
    }
  }

  async sendMessage(input: SendAgentMessageInput): Promise<Result<void, string>> {
    const runner = this.currentTaskRunner;
    if (!runner) {
      return Result.err(`Worker agent ${this.agentId} has no TaskRunner to receive a message.`);
    }
    const task = runner.assertCanReceiveMessage(input.taskId);
    const accepted = await this.enqueueMessageDelivery(input, {
      taskId: task.taskId,
      deliveryName: "Worker",
      onAccepted: () => runner.recordMessageQueued(task.taskId),
    });
    if (accepted && !this.isStopping && !this.archivingTask) this.loop.schedule();
    return Result.ok(undefined);
  }

  async archiveTask(taskId: string): Promise<AgentTaskState> {
    const runner = this.currentTaskRunner;
    if (!runner) {
      throw new Error(`Worker agent ${this.agentId} has no TaskRunner to archive.`);
    }
    const task = runner.snapshot().activeTask;
    if (!task || task.taskId !== taskId) {
      throw new Error(`Worker agent ${this.agentId} does not own task ${taskId}.`);
    }
    this.archivingTask = true;
    this.loop.stop();
    runner.cancelPreparedStep();
    try {
      await this.loop.runToIdle();
      const archived = await runner.archiveTask(taskId);
      this.clearPendingMessages();
      if (this.currentTaskRunner === runner) {
        this.currentTaskRunner = undefined;
      }
      return archived;
    } finally {
      this.archivingTask = false;
    }
  }

  async stopTask(
    taskId: string,
    reason = "任务已被 Coordinator 停止。",
  ): Promise<AgentTaskState> {
    const runner = this.currentTaskRunner;
    if (!runner) {
      throw new Error(`Worker agent ${this.agentId} has no TaskRunner for task ${taskId}.`);
    }
    if (runner.snapshot().activeTask?.taskId !== taskId) {
      throw new Error(`Worker agent ${this.agentId} does not own task ${taskId}.`);
    }
    this.clearPendingMessages();
    runner.cancelPreparedStep();
    return runner.stopTask(taskId, reason);
  }

  restoreTask(input: {
    task: AgentTaskState;
    maxTaskSequence: number;
  }): void {
    if (this.currentTaskRunner) {
      throw new Error(`Worker agent ${this.agentId} already has a TaskRunner.`);
    }
    this.taskSequence = Math.max(this.taskSequence, input.maxTaskSequence);
    this.currentTaskRunner = this.createTaskRunner({
      taskSequence: input.task.taskSequence,
      restoredTask: input.task,
    });
  }

  restoreMessages(input: {
    acceptedMessages: AgentMessage[];
    pendingMessages: AgentMessage[];
  }): void {
    this.restoreMessageState({
      acceptedMessages: input.acceptedMessages,
      pendingMessages: input.pendingMessages,
      deliveryName: "Worker",
    });
  }

  restoreTaskExecution(input: {
    resumeContext: string;
    resumeImmediately: boolean;
  }): void {
    const runner = this.currentTaskRunner;
    if (!runner) throw new Error(`Worker agent ${this.agentId} has no restored Task runner.`);
    runner.restoreExecutionState({
      resumeContext: input.resumeContext,
      resumeImmediately: input.resumeImmediately,
    });
  }

  restoreTaskSequence(taskSequence: number): void {
    if (this.currentTaskRunner) {
      throw new Error(`Worker agent ${this.agentId} cannot change task sequence with an active runner.`);
    }
    this.taskSequence = Math.max(this.taskSequence, taskSequence);
  }

  activateRestoredTask(): void {
    const runner = this.currentTaskRunner;
    if (!runner) throw new Error(`Worker agent ${this.agentId} has no restored TaskRunner.`);
    if (runner.shouldActivateRestoredTask(this.pendingMessageCount)) this.loop.schedule();
  }

  async runToIdle(): Promise<void> {
    await this.loop.runToIdle();
  }

  protected override taskSnapshot(): AgentTaskState | undefined {
    return this.currentTaskRunner?.snapshot().activeTask;
  }

  protected async stopExecution(reason: string): Promise<void> {
    this.loop.stop();
    this.currentTaskRunner?.cancelPreparedStep();
    await Promise.all([
      this.loop.runToIdle(),
      this.stepRunner.stop(reason),
    ]);
  }

  private createTaskRunner(input: {
    taskSequence: number;
    restoredTask?: AgentTaskState;
  }): TaskRunner {
    const worker = this;
    return new TaskRunner({
      ...input,
      host: {
        get agentId() {
          return worker.agentId;
        },
        get role() {
          return worker.role;
        },
        deliverTaskOutcome: async (outcome) => {
          const coordinator = worker.registry.listAgents().find((candidate) =>
            candidate instanceof CoordinatorAgent
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
            candidate instanceof CoordinatorAgent
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

  private async runWorkerTick(preparation: TaskStepPreparation): Promise<void> {
    const taskRunner = this.currentTaskRunner;
    if (!taskRunner || taskRunner.snapshot().activeTask?.taskId !== preparation.taskId) {
      throw new Error(`Worker agent ${this.agentId} has no Task runner for ${preparation.taskId}.`);
    }
    const result = await this.stepRunner.runStep({
      taskId: preparation.taskId,
      stepId: preparation.stepId,
      prompt: preparation.prompt,
      onStarted: (step) => {
        taskRunner.recordStepStarted(preparation, step);
        if (preparation.messagesToConsume.length > 0) {
          this.consumeQueuedMessages(preparation.messagesToConsume, step.stepId);
          taskRunner.recordPendingMessagesDrained(preparation.taskId);
        }
      },
    });
    await taskRunner.recordStepFinished(preparation, result);
  }
}

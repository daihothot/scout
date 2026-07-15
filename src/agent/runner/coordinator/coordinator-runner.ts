import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../../core/scout-agent.js";
import type {
  EventBus,
  ScoutEvent,
} from "../../../core/events/index.js";
import { SystemEvents } from "../../../system/events/index.js";
import { AgentEvents } from "../../events/index.js";
import { AgentInbox } from "../../core/agent-inbox.js";
import { AgenticLoop } from "../../core/agentic-loop.js";
import type {
  AgentOrchestrationDispatchRequestedPayload,
  AgentInterruptEventPayload,
} from "../../orchestration/orchestrator-events.js";
import type {
  AgentTaskNotAssignedEventPayload,
} from "../../task/task-events.js";
import type { AgentTaskState } from "../../task/types.js";
import type { SendAgentMessageInput } from "../../task/types.js";
import type { UserMessageSubmittedPayload } from "../../../interaction/gateway/interaction-events.js";
import { AgentRunner } from "../types.js";
import { attachments } from "../../context/attachments.js";
import { coordinator } from "./coordinator-attachments.js";

export interface CoordinatorRunnerHost {
  readonly agentId: string;
  readonly threadId?: string;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
}

export class CoordinatorRunner extends AgentRunner {
  readonly runnerKind = "coordinator";
  private readonly host: CoordinatorRunnerHost;
  private readonly eventBus: EventBus;
  private readonly inbox: AgentInbox;
  private readonly loop: AgenticLoop<string[]>;
  private pendingMessages: string[] = [];
  private stopped = false;
  private stopReason?: string;

  constructor(options: { host: CoordinatorRunnerHost; eventBus: EventBus }) {
    super();
    this.host = options.host;
    this.eventBus = options.eventBus;
    this.loop = new AgenticLoop<string[]>({
      agentId: this.host.agentId,
      takeTick: () => this.takeCoordinatorTick(),
      runTick: (messages) => this.runCoordinatorTick(messages),
      isStopped: () => this.stopped,
      onError: (error) => this.publishFailure(error),
    });
    this.inbox = new AgentInbox({
      eventBus: this.eventBus,
      isStopped: () => this.stopped,
      onEvents: (events) => this.handleInboxEvents(events),
      onError: (error) => this.publishFailure(error),
    });
    this.inbox.subscribe<UserMessageSubmittedPayload>(SystemEvents.interaction.userMessageSubmitted);
    this.inbox.subscribe<AgentOrchestrationDispatchRequestedPayload>(AgentEvents.orchestration.dispatchRequested);
    this.inbox.subscribe<AgentInterruptEventPayload>(AgentEvents.interrupt);
    this.inbox.subscribe<AgentTaskState>(AgentEvents.task.assigned);
    this.inbox.subscribe<AgentTaskNotAssignedEventPayload>(AgentEvents.task.notAssigned);
  }

  get agentId(): string {
    return this.host.agentId;
  }

  stop(reason?: string): void {
    this.stopped = true;
    this.stopReason = reason;
    this.inbox.stop();
    this.loop.stop();
  }

  queueMessage(input: SendAgentMessageInput): void {
    if (this.stopped) {
      throw new Error(`Coordinator runner ${this.agentId} is stopped.${this.stopReason ? ` Reason: ${this.stopReason}` : ""}`);
    }
    if (input.taskId) {
      throw new Error(`Coordinator runner ${this.agentId} does not own task ${input.taskId}.`);
    }
    this.queueMessages([attachments.compose(input.message)]);
    this.loop.schedule();
  }

  private takeCoordinatorTick(): string[] | undefined {
    return this.countPendingMessages() > 0 ? this.drainPendingMessages() : undefined;
  }

  private async handleInboxEvents(events: ScoutEvent[]): Promise<void> {
    for (const event of events) {
      if (SystemEvents.interaction.userMessageSubmitted.is(event)) {
        const payload = event.payload as UserMessageSubmittedPayload;
        if (payload.attachment.trim().length > 0) {
          this.queueMessages([payload.attachment]);
        }
        continue;
      }

      if (AgentEvents.orchestration.dispatchRequested.is(event)) {
        const payload = event.payload as AgentOrchestrationDispatchRequestedPayload;
        if (payload.attachment.trim().length > 0) {
          this.queueMessages([payload.attachment]);
        }
        continue;
      }

      if (AgentEvents.interrupt.is(event)) {
        const payload = event.payload as AgentInterruptEventPayload;
        if (payload.attachment.trim().length > 0) {
          this.queueMessages([payload.attachment]);
        }
        continue;
      }

      if (AgentEvents.task.assigned.is(event)) {
        const task = event.payload as AgentTaskState;
        this.queueMessages([coordinator.taskAssigned({
          agentId: task.agentId,
          taskId: task.taskId,
        })]);
        continue;
      }

      if (AgentEvents.task.notAssigned.is(event)) {
        const payload = event.payload as AgentTaskNotAssignedEventPayload;
        this.queueMessages([coordinator.taskNotAssigned(payload)]);
        continue;
      }

    }
    this.loop.schedule();
  }

  private async runCoordinatorTick(messages: string[]): Promise<void> {
    if (this.stopped) {
      throw new Error(`Coordinator runner ${this.agentId} is stopped.${this.stopReason ? ` Reason: ${this.stopReason}` : ""}`);
    }
    const outcome = await this.host.runTurn({
      prompt: attachments.compose(...messages),
      sandbox: "workspaceWrite",
      outputContract: "coordinator_main_loop",
    });
    this.eventBus.publish(AgentEvents.coordinator.turnCompleted, {
      agentId: this.agentId,
      threadId: outcome.turn.threadId,
      turnId: outcome.turn.turnId,
      status: outcome.turn.status,
      completedAt: outcome.turn.finishedAt,
      turn: outcome.turn,
    });
    const text = outcome.finalResponse?.trim();
    if (!text) return;
    this.eventBus.publish(AgentEvents.coordinator.messageProduced, {
      messageId: `${outcome.turn.invocationId}-message`,
      agentId: this.agentId,
      threadId: outcome.turn.threadId,
      turnId: outcome.turn.turnId,
      text,
      createdAt: outcome.turn.finishedAt,
    });
  }

  private publishFailure(error: unknown): void {
    this.eventBus.publish(AgentEvents.coordinator.messageProduced, {
      messageId: `${this.agentId}-runner-error-${Date.now()}`,
      agentId: this.agentId,
      threadId: this.host.threadId,
      text: `Coordinator turn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      createdAt: new Date().toISOString(),
      data: {
        level: "error",
      },
    });
  }

  private queueMessages(messages: string[]): void {
    if (messages.length === 0) return;
    this.pendingMessages = [...this.pendingMessages, ...messages];
  }

  private drainPendingMessages(): string[] {
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    return messages;
  }

  private countPendingMessages(): number {
    return this.pendingMessages.length;
  }
}

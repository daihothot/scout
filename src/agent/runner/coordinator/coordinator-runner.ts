import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../../core/scout-agent.js";
import type { ScoutEvent } from "../../../core/events/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { SystemEvents } from "../../../system/events/index.js";
import { AgentEvents } from "../../events/index.js";
import { AgentInbox } from "../../core/agent-inbox.js";
import { AgenticLoop } from "../../core/agentic-loop.js";
import type {
  AgentTaskNotAssignedEventPayload,
} from "../../task/task-events.js";
import type { AgentTaskState } from "../../task/types.js";
import type { SendAgentMessageInput } from "../../task/types.js";
import type { UserMessageSubmittedPayload } from "../../../interaction/gateway/interaction-events.js";
import { AgentRunner } from "../types.js";
import { attachments } from "../../context/attachments.js";
import { coordinator } from "./coordinator-attachments.js";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../../message/types.js";

/** Host callbacks through which a Coordinator runner owns its Scout agent. */
export interface CoordinatorRunnerHost {
  readonly agentId: string;
  readonly threadId?: string;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
}

/**
 * Serializes Coordinator messages into turns and task observations. It owns
 * delivery queues for the Coordinator only; task assignment remains delegated
 * to the agent backends.
 */
export class CoordinatorRunner extends AgentRunner {
  readonly runnerKind = "coordinator";
  private readonly host: CoordinatorRunnerHost;
  private readonly inbox: AgentInbox;
  private readonly loop: AgenticLoop<AgentMessage[]>;
  private readonly acceptedMessages = new Map<string, AgentMessage>();
  private pendingMessages: AgentMessage[] = [];
  private resumeContext?: string;
  private stopped = false;
  private stopReason?: string;

  constructor(options: { host: CoordinatorRunnerHost }) {
    super();
    this.host = options.host;
    this.loop = new AgenticLoop<AgentMessage[]>({
      agentId: this.host.agentId,
      takeTick: () => this.takeCoordinatorTick(),
      runTick: (messages) => this.runCoordinatorTick(messages),
      isStopped: () => this.stopped,
      onError: (error) => this.publishFailure(error),
    });
    this.inbox = new AgentInbox({
      isStopped: () => this.stopped,
      onEvents: (events) => this.handleInboxEvents(events),
      onError: (error) => this.publishFailure(error),
    });
    this.inbox.subscribe<UserMessageSubmittedPayload>(SystemEvents.interaction.userMessageSubmitted);
    this.inbox.subscribe<AgentTaskState>(AgentEvents.task.assigned);
    this.inbox.subscribe<AgentTaskNotAssignedEventPayload>(AgentEvents.task.notAssigned);
  }

  get agentId(): string {
    return this.host.agentId;
  }

  private get eventBus() {
    return currentRunScope().eventBus;
  }

  async stop(reason?: string): Promise<void> {
    this.stopped = true;
    this.stopReason = reason;
    this.inbox.stop();
    this.loop.stop();
    await Promise.all([
      this.inbox.runToIdle(),
      this.loop.runToIdle(),
    ]);
  }

  async queueMessage(input: SendAgentMessageInput): Promise<void> {
    if (input.taskId) {
      throw new Error(`Coordinator runner ${this.agentId} does not own task ${input.taskId}.`);
    }
    this.acceptMessage({
      messageId: input.delivery?.messageId ?? `${this.agentId}-message-${randomUUID()}`,
      agentId: this.agentId,
      body: attachments.compose(input.message),
      queuedAt: input.delivery?.queuedAt ?? new Date().toISOString(),
    });
    if (!this.stopped) this.loop.schedule();
  }

  restoreState(input: {
    acceptedMessages: AgentMessage[];
    pendingMessages: AgentMessage[];
    resumeContext: string;
  }): void {
    this.pendingMessages = structuredClone(input.pendingMessages);
    this.acceptedMessages.clear();
    for (const message of [...input.acceptedMessages, ...this.pendingMessages]) {
      const accepted = this.acceptedMessages.get(message.messageId);
      if (accepted && (
        accepted.agentId !== message.agentId
        || accepted.taskId !== message.taskId
        || accepted.body !== message.body
        || accepted.queuedAt !== message.queuedAt
      )) {
        throw new Error(`Message ${message.messageId} does not match its Coordinator delivery.`);
      }
      this.acceptedMessages.set(message.messageId, structuredClone(message));
    }
    this.resumeContext = input.resumeContext;
  }

  activateRestoredState(): void {
    this.loop.schedule();
  }

  override snapshot(): { pendingMessageCount: number } {
    return { pendingMessageCount: this.pendingMessages.length };
  }

  private takeCoordinatorTick(): AgentMessage[] | undefined {
    return this.pendingMessages.length > 0 || this.resumeContext
      ? structuredClone(this.pendingMessages)
      : undefined;
  }

  private async handleInboxEvents(events: ScoutEvent[]): Promise<void> {
    for (const event of events) {
      if (SystemEvents.interaction.userMessageSubmitted.is(event)) {
        const payload = event.payload;
        if (payload.attachment.trim().length > 0) {
          this.acceptMessage({
            messageId: payload.messageId,
            agentId: this.agentId,
            body: payload.attachment,
            queuedAt: payload.submittedAt,
          });
        }
        continue;
      }

      if (AgentEvents.task.assigned.is(event)) {
        const task = event.payload;
        this.acceptMessage({
          messageId: `task-assigned-${task.taskId}`,
          agentId: this.agentId,
          body: coordinator.taskAssigned({
            agentId: task.agentId,
            taskId: task.taskId,
          }),
          queuedAt: task.createdAt,
        });
        continue;
      }

      if (AgentEvents.task.notAssigned.is(event)) {
        const payload = event.payload;
        this.acceptMessage({
          messageId: event.id,
          agentId: this.agentId,
          body: coordinator.taskNotAssigned(payload),
          queuedAt: event.occurredAt,
        });
        continue;
      }

    }
    this.loop.schedule();
  }

  private async runCoordinatorTick(messages: AgentMessage[]): Promise<void> {
    if (this.stopped) {
      throw new Error(`Coordinator runner ${this.agentId} is stopped.${this.stopReason ? ` Reason: ${this.stopReason}` : ""}`);
    }
    const prompt = attachments.compose(
      ...(this.resumeContext ? [this.resumeContext] : []),
      ...messages.map((message) => message.body),
    );
    const outcome = await this.host.runTurn({
      prompt,
      outputContract: "coordinator_main_loop",
      onTurnStarted: () => {
        for (const message of messages) {
          const consumedAt = new Date().toISOString();
          this.eventBus.publish(AgentEvents.message.consumed, {
            messageId: message.messageId,
            agentId: message.agentId,
            consumedAt,
          }, {
            occurredAt: consumedAt,
          });
        }
        const consumed = new Set(messages.map((message) => message.messageId));
        this.pendingMessages = this.pendingMessages.filter((message) =>
          !consumed.has(message.messageId)
        );
        this.resumeContext = undefined;
      },
    });
    if (outcome.turn.status !== "completed") return;
    const text = outcome.finalResponse?.trim();
    if (!text) return;
    const produced = {
      messageId: `${outcome.turn.invocationId}-message`,
      agentId: this.agentId,
      threadId: outcome.turn.threadId,
      turnId: outcome.turn.turnId,
      text,
      createdAt: outcome.turn.finishedAt,
    };
    this.eventBus.publish(
      AgentEvents.coordinator.messageProduced,
      produced,
      { occurredAt: produced.createdAt },
    );
  }

  private publishFailure(error: unknown): void {
    const produced = {
      messageId: `${this.agentId}-runner-error-${Date.now()}`,
      agentId: this.agentId,
      threadId: this.host.threadId,
      text: `Coordinator turn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      createdAt: new Date().toISOString(),
      data: {
        level: "error",
      },
    };
    this.eventBus.publish(
      AgentEvents.coordinator.messageProduced,
      produced,
      { occurredAt: produced.createdAt },
    );
  }

  private acceptMessage(message: AgentMessage): void {
    const accepted = this.acceptedMessages.get(message.messageId);
    if (accepted && (
      accepted.agentId !== message.agentId
      || accepted.taskId !== message.taskId
      || accepted.body !== message.body
      || accepted.queuedAt !== message.queuedAt
    )) {
      throw new Error(`Message ${message.messageId} does not match its Coordinator delivery.`);
    }
    if (accepted) return;
    this.eventBus.publish(
      AgentEvents.message.queued,
      message,
      { occurredAt: message.queuedAt },
    );
    this.acceptedMessages.set(message.messageId, structuredClone(message));
    this.pendingMessages = [...this.pendingMessages, message];
  }
}

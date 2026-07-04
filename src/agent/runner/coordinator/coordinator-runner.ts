import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../../core/scout-agent.js";
import type {
  EventBus,
  ScoutEvent,
} from "../../../core/events/index.js";
import { EventMailbox } from "../../../core/events/index.js";
import { SystemEvents } from "../../../system/events/index.js";
import { AgentEvents } from "../../events/index.js";
import { AgenticLoop } from "../../core/agentic-loop.js";
import type {
  AgentOrchestrationDispatchRequestedPayload,
  AgentInterruptEventPayload,
} from "../../orchestration/orchestrator-events.js";
import type { UserMessageSubmittedPayload } from "../../../interaction/gateway/interaction-events.js";
import { AgentRunner } from "../types.js";
import { attachments } from "../../context/attachments.js";

export interface CoordinatorRunnerHost {
  readonly agentId: string;
  readonly threadId?: string;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
}

export class CoordinatorRunner extends AgentRunner {
  readonly runnerKind = "coordinator";
  private readonly host: CoordinatorRunnerHost;
  private readonly eventBus: EventBus;
  private readonly mailbox: EventMailbox;
  private readonly mailboxLoop: AgenticLoop<ScoutEvent[]>;
  private readonly tickLoop: AgenticLoop<CoordinatorPendingMessageTick>;
  private pendingMessages: string[] = [];
  private stopped = false;
  private stopReason?: string;

  constructor(options: { host: CoordinatorRunnerHost; eventBus: EventBus }) {
    super();
    this.host = options.host;
    this.eventBus = options.eventBus;
    this.mailbox = new EventMailbox({
      eventBus: this.eventBus,
      onEvent: () => this.mailboxLoop.schedule(),
    });
    this.mailboxLoop = new AgenticLoop<ScoutEvent[]>({
      agentId: this.host.agentId,
      handlers: {
        loopKind: "mailbox",
        takeMailboxStep: () => this.mailbox.takeAll(),
        runMailboxStep: (events) => this.runMailboxStep(events),
        isStopped: () => this.stopped,
        onError: (error) => this.publishFailure(error),
      },
    });
    this.tickLoop = new AgenticLoop<CoordinatorPendingMessageTick>({
      agentId: this.host.agentId,
      handlers: {
        loopKind: "tick",
        takeTick: () => this.takePendingMessageTick(),
        runTick: () => this.runPendingMessageTick(),
        isStopped: () => this.stopped,
        onError: (error) => this.publishFailure(error),
      },
    });
    this.mailbox.subscribe<UserMessageSubmittedPayload>(SystemEvents.interaction.userMessageSubmitted);
    this.mailbox.subscribe<AgentOrchestrationDispatchRequestedPayload>(AgentEvents.orchestration.dispatchRequested);
    this.mailbox.subscribe<AgentInterruptEventPayload>(AgentEvents.interrupt);
  }

  get agentId(): string {
    return this.host.agentId;
  }

  stop(reason?: string): void {
    this.stopped = true;
    this.stopReason = reason;
    this.mailbox.stop();
    this.mailboxLoop.stop();
    this.tickLoop.stop();
  }

  private async runMailboxStep(events: ScoutEvent[]): Promise<void> {
    const messages = events
      .map((event) => readCoordinatorAttachment(event))
      .filter((message): message is string => typeof message === "string" && message.trim().length > 0);
    this.queueMessages(messages);
    this.tickLoop.schedule();
  }

  private takePendingMessageTick(): CoordinatorPendingMessageTick | undefined {
    return this.countPendingMessages() > 0 ? { type: "pending_messages" } : undefined;
  }

  private async runPendingMessageTick(): Promise<void> {
    if (this.stopped) {
      throw new Error(`Coordinator runner ${this.agentId} is stopped.${this.stopReason ? ` Reason: ${this.stopReason}` : ""}`);
    }
    const messages = this.drainPendingMessages();
    const outcome = await this.host.runTurn({
      prompt: attachments.compose(undefined, ...messages),
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

function readCoordinatorAttachment(event: ScoutEvent): string | undefined {
  const payload = event.payload as { attachment?: unknown };
  return typeof payload.attachment === "string" ? payload.attachment : undefined;
}

interface CoordinatorPendingMessageTick {
  type: "pending_messages";
}

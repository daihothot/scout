import type {
  AgentTaskEvent,
  AgentTaskEventPayloadVariant,
} from "../../agent/task/task-events.js";
import {
  type EventBus,
  type ScoutEvent,
  type UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/index.js";
import { AgentEvents } from "../../agent/events/index.js";
import type {
  AgentMessageSend,
  RuntimeDisclosureEvent,
  RuntimeInteractionPort,
  RuntimeProgressEvent,
} from "../port.js";
import type {
  CoordinatorMessageProducedPayload,
} from "../../agent/runner/coordinator/coordinator-runner-events.js";
import { coordinator } from "../../agent/runner/coordinator/coordinator-attachments.js";
import type {
  InteractionExitRequestedPayload,
  UserMessageSubmittedPayload,
} from "./interaction-events.js";

export interface InteractionGatewayOptions {
  eventBus: EventBus;
  interactionPort: RuntimeInteractionPort;
  logger?: {
    warn(input: unknown): void;
  };
}

export class InteractionGateway {
  private readonly eventBus: EventBus;
  private readonly interactionPort: RuntimeInteractionPort;
  private readonly logger?: InteractionGatewayOptions["logger"];
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];

  constructor(options: InteractionGatewayOptions) {
    this.eventBus = options.eventBus;
    this.interactionPort = options.interactionPort;
    this.logger = options.logger;
  }

  start(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers.push(
      this.eventBus.subscribe<RuntimeDisclosureEvent>(
        SystemEvents.interaction.disclosureRequested,
        (event) => this.handleDisclosureRequest(event),
      ),
      this.eventBus.subscribe<RuntimeProgressEvent>(
        SystemEvents.interaction.progressRequested,
        (event) => this.handleProgressRequest(event),
      ),
      this.eventBus.subscribe<AgentTaskEventPayloadVariant>(
        AgentEvents.task,
        (event) => this.handleTaskEvent(event as AgentTaskEvent),
      ),
      this.eventBus.subscribe<CoordinatorMessageProducedPayload>(
        AgentEvents.coordinator.messageProduced,
        (event) => this.handleAgentMessageProduced(event),
      ),
    );
    const unsubscribeAgentMessage = this.interactionPort.sendAgentMessage?.((message) =>
      this.handleAgentMessage(message)
    );
    if (unsubscribeAgentMessage) this.unsubscribers.push(unsubscribeAgentMessage);
    const unsubscribeExit = this.interactionPort.onExitRequested?.(() =>
      this.handleExitRequested()
    );
    if (unsubscribeExit) this.unsubscribers.push(unsubscribeExit);
  }

  stop(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }

  submitUserMessage(input: {
    text: string;
    messageId?: string;
    source?: string;
    data?: unknown;
  }): void {
    const messageId = input.messageId ?? `user-message-${Date.now()}`;
    const submittedAt = new Date().toISOString();
    this.eventBus.publish(SystemEvents.interaction.userMessageSubmitted, {
      messageId,
      text: input.text,
      submittedAt,
      attachment: coordinator.user({
        messageId,
        text: input.text,
        submittedAt,
        source: input.source,
        data: input.data,
      }),
      source: input.source,
      data: input.data,
    } satisfies UserMessageSubmittedPayload);
  }

  private async handleDisclosureRequest(
    event: ScoutEvent<RuntimeDisclosureEvent>,
  ): Promise<void> {
    try {
      await this.interactionPort.disclose(event.payload);
    } catch (error) {
      this.warnInteractionError("disclosure_request_failed", error, {
        eventId: event.id,
        source: event.payload.source,
      });
    }
  }

  private async handleProgressRequest(event: ScoutEvent<RuntimeProgressEvent>): Promise<void> {
    try {
      await this.interactionPort.publishProgress(event.payload);
    } catch (error) {
      this.warnInteractionError("progress_request_failed", error, {
        eventId: event.id,
        source: event.payload.source,
        itemId: event.payload.itemId,
      });
    }
  }

  private async handleTaskEvent(event: AgentTaskEvent): Promise<void> {
    if (!shouldNotifyTaskEvent(event)) return;
    try {
      await this.interactionPort.notify(event);
    } catch (error) {
      this.warnInteractionError("notification_request_failed", error, {
        eventId: event.id,
      });
    }
  }

  private handleAgentMessageProduced(event: ScoutEvent<CoordinatorMessageProducedPayload>): void {
    void Promise.resolve(
      this.interactionPort.receiveAgentMessage({
        id: event.payload.messageId,
        text: event.payload.text,
        data: event.payload.data,
      }),
    ).catch((error) =>
      this.warnInteractionError("agent_message_failed", error, {
        eventId: event.id,
      }),
    );
  }

  private warnInteractionError(
    event: string,
    error: unknown,
    context: Record<string, unknown> = {},
  ): void {
    this.logger?.warn({
      module: "interaction.gateway",
      event,
      data: {
        ...context,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
    });
  }

  private handleAgentMessage(message: AgentMessageSend): void {
    this.submitUserMessage({
      messageId: message.id,
      text: message.text,
      data: message.data,
    });
  }

  private handleExitRequested(): void {
    this.eventBus.publish(SystemEvents.interaction.exitRequested, {
      requestedAt: new Date().toISOString(),
    } satisfies InteractionExitRequestedPayload);
  }
}

function shouldNotifyTaskEvent(event: AgentTaskEvent): boolean {
  return AgentEvents.task.terminal.is(event)
    || AgentEvents.task.humanInputRequested.is(event);
}

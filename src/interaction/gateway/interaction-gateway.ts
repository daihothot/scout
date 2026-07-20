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
} from "../protocol/port.js";
import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../agent/activity/activity-event.js";
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
      this.eventBus.subscribe<AgentActivity>(
        AgentEvents.activity.observed,
        (event) => this.handleAgentActivity(event),
      ),
      this.eventBus.subscribe<AgentTurnActivity>(
        AgentEvents.activity.turnObserved,
        (event) => this.handleAgentTurnActivity(event),
      ),
      this.eventBus.subscribe(
        AgentEvents.task,
        (event) => this.handleTaskEvent(event),
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

  private async handleAgentActivity(event: ScoutEvent<AgentActivity>): Promise<void> {
    try {
      await this.interactionPort.publishAgentActivity(event.payload);
    } catch (error) {
      this.warnInteractionError("agent_activity_publish_failed", error, {
        eventId: event.id,
        agentId: event.payload.agentId,
        itemId: event.payload.itemId,
      });
    }
  }

  private async handleAgentTurnActivity(event: ScoutEvent<AgentTurnActivity>): Promise<void> {
    try {
      await this.interactionPort.publishAgentTurnActivity(event.payload);
    } catch (error) {
      this.warnInteractionError("agent_turn_activity_publish_failed", error, {
        eventId: event.id,
        agentId: event.payload.agentId,
        turnId: event.payload.turnId,
      });
    }
  }

  private async handleTaskEvent(event: ScoutEvent): Promise<void> {
    try {
      await this.interactionPort.publishTaskEvent(event);
    } catch (error) {
      this.warnInteractionError("task_event_publish_failed", error, {
        eventId: event.id,
        eventKey: event.key.routeKey,
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

  private async handleExitRequested(): Promise<void> {
    await this.eventBus.publishAndWait(SystemEvents.interaction.exitRequested, {
      requestedAt: new Date().toISOString(),
    } satisfies InteractionExitRequestedPayload);
  }
}

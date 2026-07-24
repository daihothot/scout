import {
  type ScoutEvent,
  type UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { SystemEvents } from "../../system/events/index.js";
import { AgentEvents } from "../../agent/events/index.js";
import type {
  AgentMessageSend,
  RuntimeDisclosureEvent,
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

export class InteractionGateway {
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const scope = currentRunScope();
    this.unsubscribers.push(
      scope.eventBus.subscribe<RuntimeDisclosureEvent>(
        SystemEvents.interaction.disclosureRequested,
        (event) => this.handleDisclosureRequest(event),
      ),
      scope.eventBus.subscribe<AgentActivity>(
        AgentEvents.activity.observed,
        (event) => this.handleAgentActivity(event),
      ),
      scope.eventBus.subscribe<AgentTurnActivity>(
        AgentEvents.activity.turnObserved,
        (event) => this.handleAgentTurnActivity(event),
      ),
      scope.eventBus.subscribe(
        AgentEvents.task,
        (event) => this.handleTaskEvent(event),
      ),
      scope.eventBus.subscribe<CoordinatorMessageProducedPayload>(
        AgentEvents.coordinator.messageProduced,
        (event) => this.handleAgentMessageProduced(event),
      ),
    );
    const unsubscribeAgentMessage = scope.interactionPort.sendAgentMessage?.((message) =>
      this.handleAgentMessage(message)
    );
    if (unsubscribeAgentMessage) this.unsubscribers.push(unsubscribeAgentMessage);
    const unsubscribeExit = scope.interactionPort.onExitRequested?.(() =>
      this.handleExitRequested()
    );
    if (unsubscribeExit) this.unsubscribers.push(unsubscribeExit);
  }

  stop(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }

  async submitUserMessage(input: {
    text: string;
    messageId?: string;
    source?: string;
    data?: unknown;
  }): Promise<void> {
    const messageId = input.messageId ?? `user-message-${Date.now()}`;
    const submittedAt = new Date().toISOString();
    const payload = {
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
    } satisfies UserMessageSubmittedPayload;
    await currentRunScope().eventBus.publishAndWait(
      SystemEvents.interaction.userMessageSubmitted,
      payload,
      { occurredAt: submittedAt },
    );
  }

  private async handleDisclosureRequest(
    event: ScoutEvent<RuntimeDisclosureEvent>,
  ): Promise<void> {
    try {
      await currentRunScope().interactionPort.disclose(event.payload);
    } catch (error) {
      this.warnInteractionError("disclosure_request_failed", error, {
        eventId: event.id,
        source: event.payload.source,
      });
    }
  }

  private async handleAgentActivity(event: ScoutEvent<AgentActivity>): Promise<void> {
    try {
      await currentRunScope().interactionPort.publishAgentActivity(event.payload);
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
      await currentRunScope().interactionPort.publishAgentTurnActivity(event.payload);
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
      await currentRunScope().interactionPort.publishTaskEvent(event);
    } catch (error) {
      this.warnInteractionError("task_event_publish_failed", error, {
        eventId: event.id,
        eventKey: event.key.routeKey,
      });
    }
  }

  private handleAgentMessageProduced(event: ScoutEvent<CoordinatorMessageProducedPayload>): void {
    void Promise.resolve(
      currentRunScope().interactionPort.receiveAgentMessage({
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
    currentRunScope().logger.warn({
      module: "interaction.gateway",
      event,
      data: {
        ...context,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
    });
  }

  private async handleAgentMessage(message: AgentMessageSend): Promise<void> {
    await this.submitUserMessage({
      messageId: message.id,
      text: message.text,
      data: message.data,
    });
  }

  private async handleExitRequested(): Promise<void> {
    await currentRunScope().eventBus.publishAndWait(SystemEvents.interaction.exitRequested, {
      requestedAt: new Date().toISOString(),
    } satisfies InteractionExitRequestedPayload);
  }
}

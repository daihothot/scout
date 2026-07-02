import type {
  AgentHumanInputRequestedEventPayload,
  AgentTaskSystemEvent,
  AgentTaskSystemEventPayload,
} from "../../agent/task/task-events.js";
import {
  type EventBus,
  type ScoutEvent,
  type UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/index.js";
import { renderHumanInputPrompt } from "../protocol/index.js";
import type { RuntimeInteractionPort } from "../port.js";
import type {
  AgentMessageProducedPayload,
} from "../../agent/runner/runner-events.js";
import type {
  InteractionDisclosureRequestedPayload,
  InteractionHumanInputReceivedPayload,
  InteractionProgressRequestedPayload,
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
      this.eventBus.subscribe<InteractionDisclosureRequestedPayload>(
        SystemEvents.interaction.disclosureRequested,
        (event) => this.handleDisclosureRequest(event),
      ),
      this.eventBus.subscribe<InteractionProgressRequestedPayload>(
        SystemEvents.interaction.progressRequested,
        (event) => this.handleProgressRequest(event),
      ),
      this.eventBus.subscribe<AgentTaskSystemEventPayload>(
        SystemEvents.task,
        (event) => this.handleTaskEvent(event as AgentTaskSystemEvent),
      ),
      this.eventBus.subscribe<AgentHumanInputRequestedEventPayload>(
        SystemEvents.task.humanInputRequested,
        (event) => this.handleHumanInputRequest(event),
      ),
      this.eventBus.subscribe<AgentMessageProducedPayload>(
        SystemEvents.agent.messageProduced,
        (event) => this.handleAgentMessageProduced(event),
      ),
    );
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
    this.eventBus.publish(SystemEvents.interaction.userMessageSubmitted, {
      messageId: input.messageId ?? `user-message-${Date.now()}`,
      text: input.text,
      submittedAt: new Date().toISOString(),
      source: input.source,
      data: input.data,
    } satisfies UserMessageSubmittedPayload);
  }

  private async handleDisclosureRequest(
    event: ScoutEvent<InteractionDisclosureRequestedPayload>,
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

  private async handleProgressRequest(event: ScoutEvent<InteractionProgressRequestedPayload>): Promise<void> {
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

  private async handleTaskEvent(event: AgentTaskSystemEvent): Promise<void> {
    if (!shouldNotifyTaskEvent(event)) return;
    try {
      await this.interactionPort.notify(event);
    } catch (error) {
      this.warnInteractionError("notification_request_failed", error, {
        eventId: event.id,
      });
    }
  }

  private async handleAgentMessageProduced(event: ScoutEvent<AgentMessageProducedPayload>): Promise<void> {
    try {
      await this.interactionPort.publishAgentMessage(event.payload.text, event.payload.data);
    } catch (error) {
      this.warnInteractionError("agent_message_failed", error, {
        eventId: event.id,
      });
    }
  }

  private async handleHumanInputRequest(event: ScoutEvent<AgentHumanInputRequestedEventPayload>): Promise<void> {
    try {
      const payload = event.payload;
      const response = await this.interactionPort.requestInput({
        id: payload.request.requestId,
        prompt: renderHumanInputPrompt({
          task: payload.task,
          request: payload.request,
        }),
        reason: "Agent requested human input while executing a task.",
      });
      this.eventBus.publish(SystemEvents.interaction.humanInputReceived, {
        taskId: payload.task.taskId,
        agentId: payload.task.agentId,
        requestId: payload.request.requestId,
        response,
      } satisfies InteractionHumanInputReceivedPayload);
    } catch (error) {
      this.warnInteractionError("human_input_request_failed", error, {
        eventId: event.id,
        agentId: event.payload.task.agentId,
        taskId: event.payload.task.taskId,
        requestId: event.payload.request.requestId,
      });
    }
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
}

function shouldNotifyTaskEvent(event: AgentTaskSystemEvent): boolean {
  return SystemEvents.task.terminal.is(event)
    || SystemEvents.task.humanInputRequested.is(event)
    || SystemEvents.task.humanInputResponded.is(event);
}

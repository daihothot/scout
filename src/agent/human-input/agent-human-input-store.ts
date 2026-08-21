import {
  EventSubscriptionPriorities,
  type UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentMessage } from "../message/types.js";
import type { AgentMessageConsumedEvent } from "../message/message-events.js";
import type {
  AgentHumanInputRequestedEvent,
  AgentHumanInputRespondedEvent,
} from "./human-input-events.js";

/** Persisted request state, including an optional response delivered later. */
export interface AgentHumanInputState extends AgentHumanInputRequestedEvent {
  requestConsumption?: AgentMessageConsumedEvent;
  response?: {
    stepId: string;
    body: string;
    respondedAt: string;
    message: AgentMessage;
    consumption?: AgentMessageConsumedEvent;
  };
}

/** Rehydrates and deduplicates human-input requests from agent events. */
export class AgentHumanInputStore {
  private readonly requests = new Map<string, AgentHumanInputState>();
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const eventBus = currentRunScope().eventBus;
    this.unsubscribers.push(
      eventBus.subscribe(AgentEvents.humanInput.requested, (event) => {
        if (AgentEvents.humanInput.requested.is(event)) {
          this.applyRequested(event.payload);
        }
      }, {
        priority: EventSubscriptionPriorities.Normal,
      }),
      eventBus.subscribe(AgentEvents.humanInput.responded, (event) => {
        if (AgentEvents.humanInput.responded.is(event)) {
          this.applyResponded(event.payload);
        }
      }, {
        priority: EventSubscriptionPriorities.Normal,
      }),
      eventBus.subscribe(AgentEvents.message.consumed, (event) => {
        if (AgentEvents.message.consumed.is(event)) {
          this.applyMessageConsumed(event.payload);
        }
      }, {
        priority: EventSubscriptionPriorities.Normal,
      }),
    );
  }

  listForTask(taskId: string): AgentHumanInputState[] {
    return [...this.requests.values()]
      .filter((request) => request.taskId === taskId)
      .map((request) => structuredClone(request));
  }

  findByMessageId(messageId: string): {
    requestId: string;
    kind: "request" | "response";
  } | undefined {
    for (const request of this.requests.values()) {
      if (request.message.messageId === messageId) {
        return { requestId: request.requestId, kind: "request" };
      }
      if (request.response?.message.messageId === messageId) {
        return { requestId: request.requestId, kind: "response" };
      }
    }
    return undefined;
  }

  restore(requests: AgentHumanInputState[]): void {
    this.requests.clear();
    for (const request of requests) {
      this.requests.set(request.requestId, structuredClone(request));
    }
  }

  dispose(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }

  private applyRequested(request: AgentHumanInputRequestedEvent): void {
    const existing = this.requests.get(request.requestId);
    if (existing) {
      if (!sameRequest(existing, request)) {
        throw new Error(`Human input request ${request.requestId} conflicts with its existing state.`);
      }
      return;
    }
    this.requests.set(request.requestId, structuredClone(request));
  }

  private applyResponded(response: AgentHumanInputRespondedEvent): void {
    const request = this.requests.get(response.requestId);
    if (!request) {
      throw new Error(`Human input response has no request: ${response.requestId}`);
    }
    const existing = request.response;
    if (existing) {
      if (
        existing.stepId !== response.stepId
        || existing.body !== response.body
        || existing.respondedAt !== response.respondedAt
        || !sameMessage(existing.message, response.message)
      ) {
        throw new Error(`Human input response ${response.requestId} conflicts with its existing state.`);
      }
      return;
    }
    this.requests.set(request.requestId, {
      ...request,
      response: {
        stepId: response.stepId,
        body: response.body,
        respondedAt: response.respondedAt,
        message: structuredClone(response.message),
      },
    });
  }

  private applyMessageConsumed(consumption: AgentMessageConsumedEvent): void {
    for (const request of this.requests.values()) {
      if (request.message.messageId === consumption.messageId) {
        if (request.requestConsumption) {
          throw new Error(`Human input request ${request.requestId} was consumed more than once.`);
        }
        this.requests.set(request.requestId, {
          ...request,
          requestConsumption: structuredClone(consumption),
        });
        return;
      }
      if (request.response?.message.messageId === consumption.messageId) {
        if (request.response.consumption) {
          throw new Error(`Human input response ${request.requestId} was consumed more than once.`);
        }
        this.requests.set(request.requestId, {
          ...request,
          response: {
            ...request.response,
            consumption: structuredClone(consumption),
          },
        });
        return;
      }
    }
  }
}

function sameRequest(
  left: AgentHumanInputRequestedEvent,
  right: AgentHumanInputRequestedEvent,
): boolean {
  return left.requestId === right.requestId
    && left.stepId === right.stepId
    && left.taskId === right.taskId
    && left.agentId === right.agentId
    && left.body === right.body
    && left.requestedAt === right.requestedAt
    && sameMessage(left.message, right.message);
}

function sameMessage(left: AgentMessage, right: AgentMessage): boolean {
  return left.messageId === right.messageId
    && left.agentId === right.agentId
    && left.taskId === right.taskId
    && left.body === right.body
    && left.queuedAt === right.queuedAt
    && left.deliveryMode === right.deliveryMode;
}

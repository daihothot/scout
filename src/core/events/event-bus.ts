import type { EventKey } from "./event-key.js";
import type { EventGroup, EventType } from "./event-catalog.js";

export interface EventPublishOptions {
  id?: string;
  occurredAt?: string;
}

export const EventSubscriptionPriorities = {
  High: 300,
  Normal: 200,
  Low: 100,
} as const;
export type EventSubscriptionPriority =
  typeof EventSubscriptionPriorities[keyof typeof EventSubscriptionPriorities];

export interface EventSubscriptionOptions {
  priority?: EventSubscriptionPriority;
}

export interface ScoutEvent<TPayload = unknown> {
  id: string;
  key: EventKey;
  payload: TPayload;
  occurredAt: string;
}

export type ScoutEventHandler<TPayload = unknown> = (event: ScoutEvent<TPayload>) => void | Promise<void>;
export type UnsubscribeEventHandler = () => void;
export type EventSubscriptionTarget = EventKey | EventType | EventGroup;

export interface EventBus {
  publish<TPayload>(type: EventType, payload: TPayload, options?: EventPublishOptions): ScoutEvent<TPayload>;
  publishAndWait<TPayload>(
    type: EventType,
    payload: TPayload,
    options?: EventPublishOptions,
  ): Promise<ScoutEvent<TPayload>>;
  subscribe<TPayload>(
    target: EventSubscriptionTarget,
    handler: ScoutEventHandler<TPayload>,
    options?: EventSubscriptionOptions,
  ): UnsubscribeEventHandler;
  subscribeOnce<TPayload>(
    target: EventSubscriptionTarget,
    handler: ScoutEventHandler<TPayload>,
    options?: EventSubscriptionOptions,
  ): UnsubscribeEventHandler;
}

export class InMemoryEventBus implements EventBus {
  private readonly exactHandlers = new Map<string, RegisteredHandler[]>();
  private readonly groupHandlers = new Map<string, RegisteredHandler[]>();
  private sequence = 0;

  publish<TPayload>(
    type: EventType,
    payload: TPayload,
    options: EventPublishOptions = {},
  ): ScoutEvent<TPayload> {
    const event = this.createEvent(type, payload, options);
    void this.dispatch(event).catch(() => undefined);
    return event;
  }

  async publishAndWait<TPayload>(
    type: EventType,
    payload: TPayload,
    options: EventPublishOptions = {},
  ): Promise<ScoutEvent<TPayload>> {
    const event = this.createEvent(type, payload, options);
    await this.dispatch(event);
    return event;
  }

  subscribe<TPayload>(
    target: EventSubscriptionTarget,
    handler: ScoutEventHandler<TPayload>,
    options: EventSubscriptionOptions = {},
  ): UnsubscribeEventHandler {
    const registered = {
      once: false,
      handler: handler as ScoutEventHandler,
      target,
      priority: options.priority ?? EventSubscriptionPriorities.Low,
    };
    this.addHandler(target, registered);
    return () => this.removeHandler(target, registered.handler);
  }

  subscribeOnce<TPayload>(
    target: EventSubscriptionTarget,
    handler: ScoutEventHandler<TPayload>,
    options: EventSubscriptionOptions = {},
  ): UnsubscribeEventHandler {
    const registered = {
      once: true,
      handler: handler as ScoutEventHandler,
      target,
      priority: options.priority ?? EventSubscriptionPriorities.Low,
    };
    this.addHandler(target, registered);
    return () => this.removeHandler(target, registered.handler);
  }

  private createEvent<TPayload>(
    type: EventType,
    payload: TPayload,
    options: EventPublishOptions,
  ): ScoutEvent<TPayload> {
    this.sequence += 1;
    return Object.freeze({
      id: options.id ?? `event-${String(this.sequence).padStart(6, "0")}`,
      key: type,
      payload,
      occurredAt: options.occurredAt ?? new Date().toISOString(),
    });
  }

  private addHandler(target: EventSubscriptionTarget, registered: RegisteredHandler): void {
    const handlers = isEventGroup(target) ? this.groupHandlers : this.exactHandlers;
    const route = routeForTarget(target);
    const current = handlers.get(route) ?? [];
    handlers.set(route, [...current, registered]);
  }

  private removeHandler(target: EventSubscriptionTarget, handler: ScoutEventHandler): void {
    const handlers = isEventGroup(target) ? this.groupHandlers : this.exactHandlers;
    const route = routeForTarget(target);
    const current = handlers.get(route) ?? [];
    const next = current.filter((registered) => registered.handler !== handler);
    if (next.length === 0) {
      handlers.delete(route);
      return;
    }
    handlers.set(route, next);
  }

  private snapshotHandlers(event: ScoutEvent): RegisteredHandler[] {
    const exact = this.exactHandlers.get(event.key.routeKey) ?? [];
    const groups = [...this.groupHandlers.entries()]
      .filter(([routePrefix]) => event.key.routeKey.startsWith(routePrefix))
      .flatMap(([, handlers]) => handlers);
    return [...exact, ...groups];
  }

  private async dispatch(event: ScoutEvent): Promise<void> {
    const handlers = this.snapshotHandlers(event);
    const priorities = [...new Set(handlers.map((handler) => handler.priority))]
      .sort((left, right) => right - left);
    for (const priority of priorities) {
      const group = handlers.filter((handler) => handler.priority === priority);
      const results: Promise<void>[] = [];
      for (const registered of group) {
        if (registered.once) this.removeHandler(registered.target, registered.handler);
        try {
          results.push(Promise.resolve(registered.handler(event)));
        } catch (error) {
          results.push(Promise.reject(error));
        }
      }
      await Promise.all(results);
    }
  }
}

interface RegisteredHandler {
  once: boolean;
  handler: ScoutEventHandler;
  target: EventSubscriptionTarget;
  priority: EventSubscriptionPriority;
}

function isEventGroup(target: EventSubscriptionTarget): target is EventGroup {
  return "kind" in target && target.kind === "group";
}

function routeForTarget(target: EventSubscriptionTarget): string {
  return isEventGroup(target) ? target.routePrefix : target.routeKey;
}

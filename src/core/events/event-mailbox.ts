import type {
  EventBus,
  EventSubscriptionTarget,
  ScoutEvent,
  UnsubscribeEventHandler,
} from "./event-bus.js";

export interface EventMailboxOptions {
  eventBus: EventBus;
  onEvent?: () => void;
}

export interface EventMailboxSubscribeOptions<TPayload = unknown> {
  filter?: (event: ScoutEvent<TPayload>) => boolean;
}

export class EventMailbox {
  private readonly eventBus: EventBus;
  private readonly onEvent?: () => void;
  private readonly queue: ScoutEvent[] = [];
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private stopped = false;

  constructor(options: EventMailboxOptions) {
    this.eventBus = options.eventBus;
    this.onEvent = options.onEvent;
  }

  subscribe<TPayload>(
    target: EventSubscriptionTarget,
    options: EventMailboxSubscribeOptions<TPayload> = {},
  ): void {
    if (this.stopped) {
      throw new Error("Cannot subscribe a stopped event mailbox.");
    }
    this.unsubscribers.push(
      this.eventBus.subscribe<TPayload>(target, (event) => {
        if (options.filter && !options.filter(event)) return;
        this.push(event);
      }),
    );
  }

  push(event: ScoutEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
    this.onEvent?.();
  }

  drain(): ScoutEvent[] {
    return this.queue.splice(0);
  }

  takeAll(): ScoutEvent[] | undefined {
    if (this.queue.length === 0) return undefined;
    return this.drain();
  }

  hasEvents(): boolean {
    return this.queue.length > 0;
  }

  get size(): number {
    return this.queue.length;
  }

  stop(): void {
    this.stopped = true;
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
    this.queue.splice(0);
  }
}

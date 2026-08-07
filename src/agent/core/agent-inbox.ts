import {
  EventMailbox,
  type EventMailboxSubscribeOptions,
  type EventSubscriptionTarget,
  type ScoutEvent,
} from "../../core/events/index.js";
import { currentRunScope } from "../../run/run-scope.js";

/** Callbacks controlling an inbox's drain loop and error boundary. */
export interface AgentInboxOptions {
  isStopped(): boolean;
  onEvents(events: ScoutEvent[]): Promise<void>;
  onError(error: unknown): void | Promise<void>;
}

/** Buffers subscribed events and drains them serially until the owner stops. */
export class AgentInbox {
  private readonly mailbox: EventMailbox;
  private readonly isStopped: () => boolean;
  private readonly onEvents: (events: ScoutEvent[]) => Promise<void>;
  private readonly onError: (error: unknown) => void | Promise<void>;
  private execution?: Promise<void>;

  constructor(options: AgentInboxOptions) {
    this.isStopped = options.isStopped;
    this.onEvents = options.onEvents;
    this.onError = options.onError;
    this.mailbox = new EventMailbox({
      eventBus: currentRunScope().eventBus,
      onEvent: () => this.schedule(),
    });
  }

  subscribe<TPayload>(
    target: EventSubscriptionTarget,
    options: EventMailboxSubscribeOptions<TPayload> = {},
  ): void {
    this.mailbox.subscribe<TPayload>(target, options);
  }

  push(event: ScoutEvent): void {
    this.mailbox.push(event);
  }

  schedule(): void {
    if (this.execution) return;
    if (this.isStopped() || !this.mailbox.hasEvents()) return;
    this.execution = this.runUntilIdle().finally(() => {
      this.execution = undefined;
      if (!this.isStopped() && this.mailbox.hasEvents()) {
        this.schedule();
      }
    });
  }

  async runToIdle(): Promise<void> {
    if (!this.execution) {
      this.schedule();
    }
    await this.execution;
  }

  isRunning(): boolean {
    return Boolean(this.execution);
  }

  get size(): number {
    return this.mailbox.size;
  }

  stop(): void {
    this.mailbox.stop();
  }

  private async runUntilIdle(): Promise<void> {
    while (!this.isStopped()) {
      const events = this.mailbox.takeAll();
      if (!events) return;
      try {
        await this.onEvents(events);
      } catch (error) {
        await this.onError(error);
      }
    }
  }
}

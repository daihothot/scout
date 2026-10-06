import type { UnsubscribeEventHandler } from "../../../core/events/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { BaseDomainEvents, type BaseDomainAgentToolCallObservedEvent } from "./base-domain-events.js";

/** Projects Base tool completion events into the active Workflow's call history. */
export class BaseDomainToolCallStore {
  private readonly calls = new Map<string, BaseDomainAgentToolCallObservedEvent>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe<BaseDomainAgentToolCallObservedEvent>(
      BaseDomainEvents.agentToolCall.observed,
      (event) => this.record(event.payload),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clear();
  }

  private record(call: BaseDomainAgentToolCallObservedEvent): void {
    const existing = this.calls.get(call.callId);
    if (existing && (
      existing.agentId !== call.agentId
      || existing.namespace !== call.namespace
      || existing.tool !== call.tool
    )) {
      throw new Error(`Base Domain tool call ${call.callId} conflicts with its existing identity.`);
    }
    this.calls.set(call.callId, structuredClone(call));
  }

  list(): BaseDomainAgentToolCallObservedEvent[] {
    return [...this.calls.values()].map((call) => structuredClone(call));
  }

  restore(calls: readonly BaseDomainAgentToolCallObservedEvent[]): void {
    this.calls.clear();
    for (const call of calls) this.record(call);
  }

  clear(): void {
    this.calls.clear();
  }
}

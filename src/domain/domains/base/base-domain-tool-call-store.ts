import type { BaseDomainAgentToolCallObservedEvent } from "./base-domain-events.js";

/** Restorable authority for Base Domain dynamic-tool results in the active Flow. */
export class BaseDomainToolCallStore {
  private readonly calls = new Map<string, BaseDomainAgentToolCallObservedEvent>();

  record(call: BaseDomainAgentToolCallObservedEvent): BaseDomainAgentToolCallObservedEvent {
    const existing = this.calls.get(call.callId);
    if (existing && (
      existing.agentId !== call.agentId
      || existing.namespace !== call.namespace
      || existing.tool !== call.tool
    )) {
      throw new Error(`Base Domain tool call ${call.callId} conflicts with its existing identity.`);
    }
    const stored = structuredClone(call);
    this.calls.set(call.callId, stored);
    return structuredClone(stored);
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

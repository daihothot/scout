import type { AgentToolCallState } from "./types.js";

/** Canonical per-run authority for dynamic and MCP tool-call facts. */
export class AgentToolCallStore {
  private readonly calls = new Map<string, AgentToolCallState>();

  upsert(call: AgentToolCallState): AgentToolCallState {
    const existing = this.calls.get(call.toolCallId);
    if (existing && (
      existing.agentId !== call.agentId
      || existing.stepId !== call.stepId
      || existing.itemId !== call.itemId
      || existing.kind !== call.kind
    )) {
      throw new Error(`Tool call ${call.toolCallId} conflicts with its existing identity.`);
    }
    const next = existing ? mergeToolCall(existing, call) : cloneToolCall(call);
    this.calls.set(call.toolCallId, next);
    return cloneToolCall(next);
  }

  get(toolCallId: string): AgentToolCallState | undefined {
    const call = this.calls.get(toolCallId);
    return call ? cloneToolCall(call) : undefined;
  }

  list(input: { agentId?: string; stepId?: string; taskId?: string } = {}): AgentToolCallState[] {
    return [...this.calls.values()]
      .filter((call) => input.agentId === undefined || call.agentId === input.agentId)
      .filter((call) => input.stepId === undefined || call.stepId === input.stepId)
      .filter((call) => input.taskId === undefined || call.taskId === input.taskId)
      .map(cloneToolCall);
  }

  restore(calls: AgentToolCallState[]): void {
    this.calls.clear();
    for (const call of calls) this.calls.set(call.toolCallId, cloneToolCall(call));
  }

  dispose(): void {
    this.calls.clear();
  }
}

function mergeToolCall(current: AgentToolCallState, next: AgentToolCallState): AgentToolCallState {
  if (next.sourceSeq < current.sourceSeq) return current;
  return {
    ...current,
    ...next,
    arguments: next.arguments === undefined ? current.arguments : next.arguments,
    result: next.result === undefined ? current.result : next.result,
    error: next.error === undefined ? current.error : next.error,
    contentItems: next.contentItems === undefined ? current.contentItems : next.contentItems,
    finishedAt: next.finishedAt ?? current.finishedAt,
  };
}

function cloneToolCall(call: AgentToolCallState): AgentToolCallState {
  return structuredClone(call);
}

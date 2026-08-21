import type { AgentStepState } from "./types.js";

/** Canonical in-memory authority for Coordinator and Worker execution steps. */
export class AgentStepStore {
  private readonly steps = new Map<string, AgentStepState>();

  addStep(step: AgentStepState): AgentStepState {
    if (this.steps.has(step.stepId)) throw new Error(`Duplicate agent step id: ${step.stepId}`);
    const stored = cloneAgentStepState(step);
    this.steps.set(step.stepId, stored);
    return cloneAgentStepState(stored);
  }

  getStep(stepId: string): AgentStepState | undefined {
    const step = this.steps.get(stepId);
    return step ? cloneAgentStepState(step) : undefined;
  }

  updateStep(stepId: string, update: (step: AgentStepState) => AgentStepState): AgentStepState {
    const current = this.steps.get(stepId);
    if (!current) throw new Error(`Unknown agent step: ${stepId}`);
    const next = cloneAgentStepState(update(cloneAgentStepState(current)));
    if (next.stepId !== stepId) throw new Error(`Cannot change step id from ${stepId} to ${next.stepId}.`);
    if (next.agentId !== current.agentId || next.taskId !== current.taskId) {
      throw new Error(`Cannot move step ${stepId} to another owner.`);
    }
    this.steps.set(stepId, next);
    return cloneAgentStepState(next);
  }

  list(input: { agentId?: string; taskId?: string } = {}): AgentStepState[] {
    return [...this.steps.values()]
      .filter((step) => input.agentId === undefined || step.agentId === input.agentId)
      .filter((step) => input.taskId === undefined || step.taskId === input.taskId)
      .map(cloneAgentStepState);
  }

  restore(steps: AgentStepState[]): void {
    this.steps.clear();
    for (const step of steps) this.steps.set(step.stepId, cloneAgentStepState(step));
  }

  /** Restores one step without replacing unrelated agents' step history. */
  restoreStep(step: AgentStepState): AgentStepState {
    const existing = this.steps.get(step.stepId);
    if (existing) {
      if (existing.agentId !== step.agentId || existing.taskId !== step.taskId) {
        throw new Error(`Agent step ${step.stepId} conflicts with its existing owner.`);
      }
      return cloneAgentStepState(existing);
    }
    const restored = cloneAgentStepState(step);
    this.steps.set(restored.stepId, restored);
    return cloneAgentStepState(restored);
  }
}

export function cloneAgentStepState(step: AgentStepState): AgentStepState {
  return {
    ...step,
    toolCalls: step.toolCalls.map((call) => ({ ...call })),
    plan: step.plan === undefined ? undefined : cloneJson(step.plan),
    humanInputResponse: step.humanInputResponse ? { ...step.humanInputResponse } : undefined,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

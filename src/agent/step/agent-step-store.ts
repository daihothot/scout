import type { AppServerPlanState } from "../../agent-server/codex/app-server-event-store.js";
import {
  EventSubscriptionPriorities,
  type UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentToolCallState } from "../tool-call/types.js";
import type { AgentStepHumanInputReference, AgentStepState } from "./types.js";

/** Active Step projection and canonical in-memory authority for Agent execution steps. */
export class AgentStepStore {
  private readonly steps = new Map<string, AgentStepState>();
  private readonly pendingHumanInputReferences = new Map<string, AgentStepHumanInputReference[]>();
  private readonly pendingToolCallReferences = new Map<string, AgentToolCallState[]>();
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private eventBus?: RunScope["eventBus"];
  private humanInputStore?: RunScope["humanInputStore"];

  /** Starts the Store-owned subscriptions that project related Agent facts into Steps. */
  start(): void {
    if (this.unsubscribers.length > 0) return;
    const scope = currentRunScope();
    this.eventBus = scope.eventBus;
    this.humanInputStore = scope.humanInputStore;
    try {
      this.unsubscribers.push(
        this.eventBus.subscribe(AgentEvents.humanInput.requested, (event) => {
          if (!AgentEvents.humanInput.requested.is(event)) return;
          this.recordHumanInputReference(event.payload.stepId, {
            requestId: event.payload.requestId,
            kind: "request_produced",
          });
        }, { priority: EventSubscriptionPriorities.Low }),
        this.eventBus.subscribe(AgentEvents.humanInput.responded, (event) => {
          if (!AgentEvents.humanInput.responded.is(event)) return;
          this.recordHumanInputReference(event.payload.stepId, {
            requestId: event.payload.requestId,
            kind: "response_produced",
          });
        }, { priority: EventSubscriptionPriorities.Low }),
        this.eventBus.subscribe(AgentEvents.toolCall.observed, (event) => {
          if (!AgentEvents.toolCall.observed.is(event)) return;
          this.recordToolCallReference(event.payload);
        }, { priority: EventSubscriptionPriorities.Low }),
        this.eventBus.subscribe(AgentEvents.message.consumed, (event) => {
          if (!AgentEvents.message.consumed.is(event)) return;
          const humanInput = this.humanInputStore?.findByMessageId(event.payload.messageId);
          if (!humanInput) return;
          this.recordHumanInputReference(event.payload.stepId, {
            requestId: humanInput.requestId,
            kind: humanInput.kind === "request" ? "request_consumed" : "response_consumed",
          });
        }, { priority: EventSubscriptionPriorities.Low }),
      );
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.pendingHumanInputReferences.clear();
    this.pendingToolCallReferences.clear();
    this.eventBus = undefined;
    this.humanInputStore = undefined;
  }

  addStep(step: AgentStepState): AgentStepState {
    if (this.steps.has(step.stepId)) throw new Error(`Duplicate agent step id: ${step.stepId}`);
    const stored = cloneAgentStepState(step);
    this.steps.set(step.stepId, stored);
    this.flushPendingReferences(step.stepId);
    return this.getStep(step.stepId)!;
  }

  startStep(step: AgentStepState): AgentStepState {
    const started = this.addStep(step);
    this.requireEventBus().publish(AgentEvents.step.started, started, {
      occurredAt: started.startedAt,
    });
    return started;
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
    this.pendingHumanInputReferences.clear();
    this.pendingToolCallReferences.clear();
    for (const step of steps) this.steps.set(step.stepId, cloneAgentStepState(step));
  }

  /** Restores one step without replacing unrelated agents' step history. */
  restoreStep(step: AgentStepState): AgentStepState {
    const existing = this.steps.get(step.stepId);
    if (existing) {
      if (existing.agentId !== step.agentId || existing.taskId !== step.taskId) {
        throw new Error(`Agent step ${step.stepId} conflicts with its existing owner.`);
      }
      this.flushPendingReferences(step.stepId);
      return cloneAgentStepState(existing);
    }
    const restored = cloneAgentStepState(step);
    this.steps.set(restored.stepId, restored);
    this.flushPendingReferences(restored.stepId);
    return cloneAgentStepState(restored);
  }

  applyPlanObservation(
    agentId: string,
    plan: AppServerPlanState & { turnId: string },
  ): AgentStepState | undefined {
    const runningSteps = this.list({ agentId }).filter((step) => step.status === "running");
    if (runningSteps.length === 0) return undefined;
    if (runningSteps.length !== 1 || !runningSteps[0]) {
      throw new Error(`Agent ${agentId} has multiple running steps for plan update.`);
    }
    const currentStep = runningSteps[0];
    if (currentStep.turnId && currentStep.turnId !== plan.turnId) {
      throw new Error(
        `Agent step ${currentStep.stepId} belongs to turn ${currentStep.turnId}, not ${plan.turnId}.`,
      );
    }
    const updatedAt = new Date().toISOString();
    const step = this.updateStep(currentStep.stepId, (current) => ({
      ...current,
      turnId: plan.turnId,
      plan,
      updatedAt,
    }));
    this.requireEventBus().publish(AgentEvents.step.planUpdated, {
      stepId: step.stepId,
      agentId: step.agentId,
      taskId: step.taskId,
      turnId: plan.turnId,
      plan,
      updatedAt,
    }, { occurredAt: updatedAt });
    return step;
  }

  recordHumanInputReference(
    stepId: string,
    reference: AgentStepHumanInputReference,
  ): AgentStepState | undefined {
    const current = this.getStep(stepId);
    if (!current) {
      const pending = this.pendingHumanInputReferences.get(stepId) ?? [];
      if (!pending.some((candidate) =>
        candidate.requestId === reference.requestId && candidate.kind === reference.kind
      )) {
        pending.push({ ...reference });
        this.pendingHumanInputReferences.set(stepId, pending);
      }
      return undefined;
    }
    if (current.status !== "running") {
      throw new Error(`Agent step ${stepId} cannot record Human Input from status ${current.status}.`);
    }
    if (current.humanInputReferences.some((candidate) =>
      candidate.requestId === reference.requestId && candidate.kind === reference.kind
    )) return undefined;
    const updatedAt = new Date().toISOString();
    const step = this.updateStep(stepId, (stored) => ({
      ...stored,
      humanInputReferences: [...stored.humanInputReferences, reference],
      updatedAt,
    }));
    this.requireEventBus().publish(AgentEvents.step.humanInputReferenced, step, {
      occurredAt: updatedAt,
    });
    return step;
  }

  recordToolCallReference(call: AgentToolCallState): AgentStepState | undefined {
    const current = this.getStep(call.stepId);
    if (!current) {
      const pending = this.pendingToolCallReferences.get(call.stepId) ?? [];
      if (!pending.some((candidate) => candidate.toolCallId === call.toolCallId)) {
        pending.push(structuredClone(call));
        this.pendingToolCallReferences.set(call.stepId, pending);
      }
      return undefined;
    }
    if (current.agentId !== call.agentId || current.taskId !== call.taskId) {
      throw new Error(`Tool call ${call.toolCallId} conflicts with Step ${call.stepId} ownership.`);
    }
    if (current.turnId && current.turnId !== call.turnId) {
      throw new Error(`Tool call ${call.toolCallId} belongs to turn ${call.turnId}, not Step turn ${current.turnId}.`);
    }
    if (current.toolCallIds.includes(call.toolCallId)) return undefined;
    const updatedAt = new Date().toISOString();
    const step = this.updateStep(call.stepId, (stored) => ({
      ...stored,
      toolCallIds: [...stored.toolCallIds, call.toolCallId],
      updatedAt,
    }));
    this.requireEventBus().publish(AgentEvents.step.toolCallReferenced, step, {
      occurredAt: updatedAt,
    });
    return step;
  }

  completeStep(stepId: string, input: AgentStepTerminalInput): AgentStepState {
    return this.finishStep(stepId, "completed", input);
  }

  interruptStep(stepId: string, input: AgentStepTerminalInput): AgentStepState {
    return this.finishStep(stepId, "interrupted", input);
  }

  failStep(stepId: string, input: AgentStepTerminalInput): AgentStepState {
    return this.finishStep(stepId, "failed", input);
  }

  private requireEventBus(): RunScope["eventBus"] {
    if (!this.eventBus) throw new Error("AgentStepStore is not started.");
    return this.eventBus;
  }

  private flushPendingReferences(stepId: string): void {
    const humanInputReferences = this.pendingHumanInputReferences.get(stepId) ?? [];
    this.pendingHumanInputReferences.delete(stepId);
    for (const reference of humanInputReferences) {
      this.recordHumanInputReference(stepId, reference);
    }

    const toolCalls = this.pendingToolCallReferences.get(stepId) ?? [];
    this.pendingToolCallReferences.delete(stepId);
    for (const call of toolCalls) {
      this.recordToolCallReference(call);
    }
  }

  private finishStep(
    stepId: string,
    status: Exclude<AgentStepState["status"], "running">,
    input: AgentStepTerminalInput,
  ): AgentStepState {
    const current = this.steps.get(stepId);
    if (!current) throw new Error(`Unknown agent step: ${stepId}`);
    if (current.status !== "running") {
      throw new Error(`Agent step ${stepId} is already ${current.status}; cannot mark it ${status}.`);
    }
    if (input.turnId && current.turnId && current.turnId !== input.turnId) {
      throw new Error(`Agent step ${stepId} belongs to turn ${current.turnId}, not ${input.turnId}.`);
    }
    const stored = this.updateStep(stepId, (step) => {
      const next: AgentStepState = {
        ...step,
        status,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        error: input.error,
        updatedAt: input.finishedAt,
      };
      if (Object.hasOwn(input, "turnId")) next.turnId = input.turnId;
      if (Object.hasOwn(input, "finalResponse")) next.finalResponse = input.finalResponse;
      if (Object.hasOwn(input, "plan")) next.plan = input.plan;
      if (Object.hasOwn(input, "toolCallIds")) next.toolCallIds = [...(input.toolCallIds ?? [])];
      return next;
    });
    const event = status === "completed"
      ? AgentEvents.step.completed
      : status === "interrupted"
        ? AgentEvents.step.interrupted
        : AgentEvents.step.failed;
    this.requireEventBus().publish(event, stored, { occurredAt: input.finishedAt });
    return stored;
  }
}

export interface AgentStepTerminalInput {
  finishedAt: string;
  durationMs: number;
  error?: string;
  turnId?: string;
  finalResponse?: string;
  plan?: AppServerPlanState;
  toolCallIds?: string[];
}

export function cloneAgentStepState(step: AgentStepState): AgentStepState {
  return {
    ...step,
    toolCallIds: [...step.toolCallIds],
    plan: step.plan === undefined ? undefined : cloneJson(step.plan),
    humanInputReferences: step.humanInputReferences.map((reference) => ({ ...reference })),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

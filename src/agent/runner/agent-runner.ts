import type { AgentStepState } from "../step/types.js";
import type { AgentStepStore } from "../step/agent-step-store.js";
import { currentRunScope } from "../../run/run-scope.js";
import type { ScoutAgentTurnOutcome } from "../core/scout-agent.js";
import { AgentEvents } from "../events/index.js";

/** Common Step state boundary for role-specific Agent runners. */
export abstract class AgentRunner {
  abstract readonly agentId: string;
  protected readonly stepStore: AgentStepStore;
  protected stopped = false;
  protected stopReason?: string;
  private stepSequence = 0;

  protected constructor() {
    this.stepStore = currentRunScope().stepStore;
  }

  /** Prevents this Step runner from accepting another Step. */
  protected stopStepRunner(reason?: string): void {
    this.stopped = true;
    this.stopReason = reason;
  }

  protected startStep(input: {
    taskId?: string;
    prompt: string;
    humanInputResponse?: AgentStepState["humanInputResponse"];
    startedAt?: string;
    stepId?: string;
  }): AgentStepState {
    const startedAt = input.startedAt ?? new Date().toISOString();
    let stepId = input.stepId;
    if (!stepId) {
      do {
        stepId = `${this.agentId}-step-${String(++this.stepSequence).padStart(4, "0")}`;
      } while (this.stepStore.list({ agentId: this.agentId }).some((step) => step.stepId === stepId));
    }
    const stored = this.stepStore.addStep({
      stepId,
      agentId: this.agentId,
      taskId: input.taskId,
      status: "running",
      prompt: input.prompt,
      toolCalls: [],
      humanInputResponse: input.humanInputResponse,
      startedAt,
      updatedAt: startedAt,
    });
    this.runtimeEventBus.publish(AgentEvents.step.started, stored, { occurredAt: stored.startedAt });
    return stored;
  }

  protected completeStep(
    stepId: string,
    outcome: ScoutAgentTurnOutcome,
    durationMs: number,
  ): AgentStepState {
    return this.finishStep(stepId, "completed", outcome, durationMs);
  }

  protected interruptStep(stepId: string, outcome: ScoutAgentTurnOutcome, durationMs: number): AgentStepState {
    return this.finishStep(stepId, "interrupted", outcome, durationMs);
  }

  protected failStep(stepId: string, outcome: ScoutAgentTurnOutcome, durationMs: number): AgentStepState {
    return this.finishStep(stepId, "failed", outcome, durationMs);
  }

  protected failRunningStep(stepId: string, error: unknown): AgentStepState | undefined {
    const current = this.stepStore.getStep(stepId);
    if (!current || current.status !== "running") return undefined;
    const failedAt = new Date().toISOString();
    const failed = this.stepStore.updateStep(stepId, (step) => ({
      ...step,
      status: "failed",
      finishedAt: failedAt,
      durationMs: Math.max(0, Date.parse(failedAt) - Date.parse(step.startedAt)),
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      updatedAt: failedAt,
    }));
    this.runtimeEventBus.publish(
      AgentEvents.step.failed,
      failed,
      { occurredAt: failedAt },
    );
    return failed;
  }

  private finishStep(
    stepId: string,
    status: Exclude<AgentStepState["status"], "running">,
    outcome: ScoutAgentTurnOutcome,
    durationMs: number,
  ): AgentStepState {
    const current = this.stepStore.getStep(stepId);
    if (!current) throw new Error(`Unknown agent step: ${stepId}`);
    if (current.status !== "running") {
      throw new Error(`Agent step ${stepId} is already ${current.status}; cannot mark it ${status}.`);
    }
    if (current.turnId && current.turnId !== outcome.turn.turnId) {
      throw new Error(`Agent step ${stepId} belongs to turn ${current.turnId}, not ${outcome.turn.turnId}.`);
    }
    const stored = this.stepStore.updateStep(stepId, (step) => ({
      ...step,
      turnId: outcome.turn.turnId,
      finalResponse: outcome.finalResponse,
      toolCalls: outcome.toolCalls ?? [],
      plan: outcome.plan,
      finishedAt: outcome.turn.finishedAt,
      durationMs,
      error: outcome.turn.error,
      status,
      updatedAt: outcome.turn.finishedAt,
    }));
    const event = status === "completed"
      ? AgentEvents.step.completed
      : status === "interrupted"
        ? AgentEvents.step.interrupted
        : AgentEvents.step.failed;
    this.runtimeEventBus.publish(event, stored, { occurredAt: outcome.turn.finishedAt });
    return stored;
  }

  private get runtimeEventBus() {
    return currentRunScope().eventBus;
  }
}

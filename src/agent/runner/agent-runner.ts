import type { AgentStepState } from "../step/types.js";
import type { AgentStepStore, AgentStepTerminalInput } from "../step/agent-step-store.js";
import { currentRunScope } from "../../run/run-scope.js";
import type { ScoutAgentTurnOutcome } from "../core/scout-agent.js";

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
    return this.stepStore.startStep({
      stepId,
      agentId: this.agentId,
      taskId: input.taskId,
      status: "running",
      prompt: input.prompt,
      toolCallIds: [],
      humanInputReferences: [],
      startedAt,
      updatedAt: startedAt,
    });
  }

  protected completeStep(
    stepId: string,
    outcome: ScoutAgentTurnOutcome,
    durationMs: number,
  ): AgentStepState {
    return this.stepStore.completeStep(stepId, this.terminalInput(stepId, outcome, durationMs));
  }

  protected interruptStep(stepId: string, outcome: ScoutAgentTurnOutcome, durationMs: number): AgentStepState {
    return this.stepStore.interruptStep(stepId, this.terminalInput(stepId, outcome, durationMs));
  }

  protected failStep(stepId: string, outcome: ScoutAgentTurnOutcome, durationMs: number): AgentStepState {
    return this.stepStore.failStep(stepId, this.terminalInput(stepId, outcome, durationMs));
  }

  protected failRunningStep(stepId: string, error: unknown): AgentStepState | undefined {
    const current = this.stepStore.getStep(stepId);
    if (!current || current.status !== "running") return undefined;
    const failedAt = new Date().toISOString();
    return this.stepStore.failStep(stepId, {
      finishedAt: failedAt,
      durationMs: Math.max(0, Date.parse(failedAt) - Date.parse(current.startedAt)),
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }

  private terminalInput(
    stepId: string,
    outcome: ScoutAgentTurnOutcome,
    durationMs: number,
  ): AgentStepTerminalInput {
    return {
      turnId: outcome.turn.turnId,
      finalResponse: outcome.finalResponse,
      plan: outcome.plan,
      toolCallIds: currentRunScope().toolCallStore
        .list({ stepId })
        .map((call) => call.toolCallId),
      finishedAt: outcome.turn.finishedAt,
      durationMs,
      error: outcome.turn.error,
    };
  }
}

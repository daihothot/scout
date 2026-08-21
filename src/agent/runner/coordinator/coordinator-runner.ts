import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../../core/scout-agent.js";
import { AgentRunner } from "../agent-runner.js";
import type { AgentStepState } from "../../step/types.js";

/** Host callback supplied by the Coordinator Agent that owns this Step runner. */
export interface CoordinatorRunnerHost {
  readonly agentId: string;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
}

export interface CoordinatorStepInput {
  prompt: string;
  outputContract?: string;
  onTurnStarted?(step: AgentStepState): void | Promise<void>;
}

export interface CoordinatorStepResult {
  step: AgentStepState;
  outcome: ScoutAgentTurnOutcome;
}

/** Executes Coordinator Steps without owning the Coordinator scheduling loop. */
export class CoordinatorRunner extends AgentRunner {
  private readonly host: CoordinatorRunnerHost;
  private activeStep?: Promise<CoordinatorStepResult>;

  constructor(options: { host: CoordinatorRunnerHost }) {
    super();
    this.host = options.host;
  }

  get agentId(): string {
    return this.host.agentId;
  }

  async stop(reason?: string): Promise<void> {
    this.stopStepRunner(reason);
    await this.activeStep?.catch(() => undefined);
  }

  runStep(input: CoordinatorStepInput): Promise<CoordinatorStepResult> {
    if (this.stopped) {
      throw new Error(`Coordinator runner ${this.agentId} is stopped.${this.stopReason ? ` Reason: ${this.stopReason}` : ""}`);
    }
    if (this.activeStep) {
      throw new Error(`Coordinator runner ${this.agentId} already has an active step.`);
    }
    const execution = this.executeStep(input);
    this.activeStep = execution;
    void execution.finally(() => {
      if (this.activeStep === execution) this.activeStep = undefined;
    }).catch(() => undefined);
    return execution;
  }

  private async executeStep(input: CoordinatorStepInput): Promise<CoordinatorStepResult> {
    const step = this.startStep({ prompt: input.prompt });
    try {
      const outcome = await this.host.runTurn({
        prompt: input.prompt,
        outputContract: input.outputContract,
        onTurnStarted: () => input.onTurnStarted?.(step),
      });
      const durationMs = durationSince(step.startedAt);
      const finished = outcome.turn.status === "completed"
        ? this.completeStep(step.stepId, outcome, durationMs)
        : outcome.turn.status === "interrupted"
          ? this.interruptStep(step.stepId, outcome, durationMs)
          : this.failStep(step.stepId, outcome, durationMs);
      return { step: finished, outcome };
    } catch (error) {
      this.failRunningStep(step.stepId, error);
      throw error;
    }
  }
}

function durationSince(startedAt: string): number {
  return Math.max(0, Date.now() - Date.parse(startedAt));
}

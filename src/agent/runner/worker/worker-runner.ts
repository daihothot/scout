import {
  attachments,
} from "../../context/attachments.js";
import {
  AgentContextTags,
} from "../../context/agent-attachments.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../../core/scout-agent.js";
import type { AgentStepState } from "../../step/types.js";
import { AgentRunner } from "../agent-runner.js";

/** Host callback supplied by the Worker Agent that owns this Step runner. */
export interface WorkerRunnerHost {
  readonly agentId: string;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
}

/** Input for one Worker Agent step. Task policy remains owned by TaskRunner. */
export interface WorkerStepInput {
  taskId: string;
  stepId: string;
  prompt: string;
  startedAt?: string;
  onStarted(step: AgentStepState): void | Promise<void>;
}

/** Completed Worker step and the app-server turn outcome that produced it. */
export interface WorkerStepResult {
  step: AgentStepState;
  outcome: ScoutAgentTurnOutcome;
}

/** Executes Worker Agent steps without owning Worker Task lifecycle policy. */
export class WorkerRunner extends AgentRunner {
  private readonly host: WorkerRunnerHost;
  private activeStep?: Promise<WorkerStepResult>;

  constructor(options: { host: WorkerRunnerHost }) {
    super();
    this.host = options.host;
  }

  get agentId(): string {
    return this.host.agentId;
  }

  runStep(input: WorkerStepInput): Promise<WorkerStepResult> {
    if (this.stopped) {
      throw new Error(`Worker runner ${this.agentId} is stopped.`);
    }
    if (this.activeStep) {
      throw new Error(`Worker runner ${this.agentId} already has an active step.`);
    }
    const execution = this.executeStep(input);
    this.activeStep = execution;
    void execution.finally(() => {
      if (this.activeStep === execution) this.activeStep = undefined;
    }).catch(() => undefined);
    return execution;
  }

  async stop(reason?: string): Promise<void> {
    this.stopStepRunner(reason);
    await this.activeStep?.catch(() => undefined);
  }

  private async executeStep(input: WorkerStepInput): Promise<WorkerStepResult> {
    const prompt = attachments.compose(input.prompt);
    const runningStep = this.startStep({
      stepId: input.stepId,
      taskId: input.taskId,
      prompt,
      humanInputResponse: attachments.readTagBlock(
        prompt,
        AgentContextTags.HumanResponse,
      ).map(({ body }) => ({ body }))[0],
      startedAt: input.startedAt,
    });

    try {
      await input.onStarted(runningStep);
      const startedAt = Date.now();
      const outcome = await this.host.runTurn({ prompt });
      const durationMs = Date.now() - startedAt;
      const step = outcome.turn.status === "completed"
        ? this.completeStep(runningStep.stepId, outcome, durationMs)
        : outcome.turn.status === "interrupted"
          ? this.interruptStep(runningStep.stepId, outcome, durationMs)
          : this.failStep(runningStep.stepId, outcome, durationMs);
      return { step, outcome };
    } catch (error) {
      this.failRunningStep(runningStep.stepId, error);
      throw error;
    }
  }
}

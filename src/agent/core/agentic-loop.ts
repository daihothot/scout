export interface AgenticLoopHandlers<TStep> {
  takeStep(): TStep | undefined;
  runStep(step: TStep): Promise<void>;
  isStopped(): boolean;
  onError(error: unknown): void;
}

export interface AgenticLoopOptions<TStep> {
  agentId: string;
  handlers: AgenticLoopHandlers<TStep>;
}

export class AgenticLoop<TStep> {
  readonly agentId: string;
  private readonly handlers: AgenticLoopHandlers<TStep>;
  private execution?: Promise<void>;
  private pendingStep?: TStep;

  constructor(options: AgenticLoopOptions<TStep>) {
    this.agentId = options.agentId;
    this.handlers = options.handlers;
  }

  schedule(): void {
    if (this.execution) return;
    if (this.handlers.isStopped() || !this.hasStep()) return;
    this.execution = this.runUntilIdle().finally(() => {
      this.execution = undefined;
      if (!this.handlers.isStopped() && this.hasStep()) {
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

  private async runUntilIdle(): Promise<void> {
    while (!this.handlers.isStopped()) {
      const step = this.takeStep();
      if (step === undefined) return;
      await this.runStep(step);
    }
  }

  private async runStep(step: TStep): Promise<void> {
    try {
      await this.handlers.runStep(step);
    } catch (error) {
      this.handlers.onError(error);
    }
  }

  private hasStep(): boolean {
    if (this.pendingStep !== undefined) return true;
    const step = this.handlers.takeStep();
    if (step === undefined) return false;
    this.pendingStep = step;
    return true;
  }

  private takeStep(): TStep | undefined {
    if (this.pendingStep !== undefined) {
      const step = this.pendingStep;
      this.pendingStep = undefined;
      return step;
    }
    return this.handlers.takeStep();
  }
}

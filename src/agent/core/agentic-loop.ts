export interface AgenticLoopHandlers {
  runStep(): Promise<void>;
  hasPendingWork(): boolean;
  isStopped(): boolean;
  onError(error: unknown): void;
}

export interface AgenticLoopOptions {
  agentId: string;
  handlers: AgenticLoopHandlers;
}

export class AgenticLoop {
  readonly agentId: string;
  private readonly handlers: AgenticLoopHandlers;
  private execution?: Promise<void>;

  constructor(options: AgenticLoopOptions) {
    this.agentId = options.agentId;
    this.handlers = options.handlers;
  }

  schedule(): void {
    if (this.execution) return;
    if (this.handlers.isStopped() || !this.handlers.hasPendingWork()) return;
    this.execution = this.runUntilIdle().finally(() => {
      this.execution = undefined;
      if (!this.handlers.isStopped() && this.handlers.hasPendingWork()) {
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
    while (!this.handlers.isStopped() && this.handlers.hasPendingWork()) {
      await this.runStep();
    }
  }

  private async runStep(): Promise<void> {
    try {
      await this.handlers.runStep();
    } catch (error) {
      this.handlers.onError(error);
    }
  }
}

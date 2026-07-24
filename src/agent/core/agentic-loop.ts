export interface AgenticLoopCommonHandlers {
  isStopped(): boolean;
  onError(error: unknown): void | Promise<void>;
}

export interface AgenticTickLoopHandlers<TTick> extends AgenticLoopCommonHandlers {
  takeTick(): TTick | undefined;
  runTick(tick: TTick): Promise<void>;
}

export interface AgenticLoopOptions<TTick> extends AgenticTickLoopHandlers<TTick> {
  agentId: string;
}

export class AgenticLoop<TTick> {
  readonly agentId: string;
  private readonly handlers: AgenticTickLoopHandlers<TTick>;
  private execution?: Promise<void>;
  private pendingWork?: TTick;

  constructor(options: AgenticLoopOptions<TTick>) {
    this.agentId = options.agentId;
    this.handlers = options;
  }

  schedule(): void {
    if (this.execution) return;
    if (this.handlers.isStopped() || !this.hasWork()) return;
    this.execution = this.runUntilIdle().finally(() => {
      this.execution = undefined;
      if (!this.handlers.isStopped() && this.hasWork()) {
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

  stop(): void {
    this.pendingWork = undefined;
  }

  private async runUntilIdle(): Promise<void> {
    while (!this.handlers.isStopped()) {
      const work = this.takeWork();
      if (work === undefined) return;
      await this.runWork(work);
    }
  }

  private async runWork(work: TTick): Promise<void> {
    try {
      await this.handlers.runTick(work);
    } catch (error) {
      await this.handlers.onError(error);
    }
  }

  private hasWork(): boolean {
    if (this.pendingWork !== undefined) return true;
    const work = this.takeWorkFromHandlers();
    if (work === undefined) return false;
    this.pendingWork = work;
    return true;
  }

  private takeWork(): TTick | undefined {
    if (this.pendingWork !== undefined) {
      const work = this.pendingWork;
      this.pendingWork = undefined;
      return work;
    }
    return this.takeWorkFromHandlers();
  }

  private takeWorkFromHandlers(): TTick | undefined {
    return this.handlers.takeTick();
  }
}

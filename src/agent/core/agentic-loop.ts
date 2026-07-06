export interface AgenticLoopCommonHandlers {
  isStopped(): boolean;
  onError(error: unknown): void;
}

export interface AgenticTickContinuation<TTick> {
  continueAfterMs?: number;
  continueWith?: TTick;
}

export interface AgenticTickLoopHandlers<TTick> extends AgenticLoopCommonHandlers {
  takeTick(): TTick | undefined;
  runTick(tick: TTick): Promise<void | AgenticTickContinuation<TTick>>;
}

export interface AgenticLoopOptions<TTick> extends AgenticTickLoopHandlers<TTick> {
  agentId: string;
}

export class AgenticLoop<TTick> {
  readonly agentId: string;
  private readonly handlers: AgenticTickLoopHandlers<TTick>;
  private execution?: Promise<void>;
  private pendingWork?: TTick;
  private delayedWork?: TTick;
  private delayedSchedule?: NodeJS.Timeout;
  private delayedScheduleVersion = 0;

  constructor(options: AgenticLoopOptions<TTick>) {
    this.agentId = options.agentId;
    this.handlers = options;
  }

  schedule(): void {
    if (this.execution) return;
    if (this.handlers.isStopped() || !this.hasWork({ includeDelayed: false })) return;
    this.clearDelayedSchedule();
    this.execution = this.runUntilIdle().finally(() => {
      this.execution = undefined;
      if (!this.handlers.isStopped() && this.hasWork({ includeDelayed: false })) {
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
    this.clearDelayedSchedule();
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
      const continuation = await this.handlers.runTick(work);
      this.scheduleTickContinuation(work, continuation);
    } catch (error) {
      this.handlers.onError(error);
    }
  }

  private hasWork(input: { includeDelayed: boolean }): boolean {
    if (this.pendingWork !== undefined) return true;
    if (input.includeDelayed && this.delayedWork !== undefined) return true;
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
    if (this.delayedWork !== undefined) {
      const work = this.delayedWork;
      this.delayedWork = undefined;
      return work;
    }
    return this.takeWorkFromHandlers();
  }

  private takeWorkFromHandlers(): TTick | undefined {
    return this.handlers.takeTick();
  }

  private scheduleTickContinuation(work: TTick, continuation: void | AgenticTickContinuation<TTick>): void {
    if (!continuation || continuation.continueAfterMs === undefined) return;
    const delayMs = Math.max(0, continuation.continueAfterMs);
    const nextWork = continuation.continueWith ?? work;
    this.clearDelayedSchedule();
    const version = ++this.delayedScheduleVersion;
    const timer = setTimeout(() => {
      if (version !== this.delayedScheduleVersion) return;
      this.delayedSchedule = undefined;
      if (this.handlers.isStopped()) return;
      this.delayedWork = nextWork;
      this.scheduleDelayedWork();
    }, delayMs);
    timer.unref?.();
    this.delayedSchedule = timer;
  }

  private scheduleDelayedWork(): void {
    if (this.execution) return;
    if (this.handlers.isStopped() || !this.hasWork({ includeDelayed: true })) return;
    this.execution = this.runUntilIdle().finally(() => {
      this.execution = undefined;
      if (!this.handlers.isStopped() && this.hasWork({ includeDelayed: false })) {
        this.schedule();
      }
    });
  }

  private clearDelayedSchedule(): void {
    this.delayedScheduleVersion += 1;
    if (this.delayedSchedule) {
      clearTimeout(this.delayedSchedule);
    }
    this.delayedSchedule = undefined;
    this.delayedWork = undefined;
  }
}

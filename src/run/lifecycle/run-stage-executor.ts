import type { Logger } from "../../core/logging/index.js";
import type {
  RunLifecycleSnapshot,
  RunLifecycleStatus,
  RunStage,
  RunStageSnapshot,
} from "./run-stage.js";

/** Inputs for lifecycle execution and optional state observation. */
export interface RunStageExecutorOptions {
  runId: string;
  logger: Logger;
  onStateChange?(snapshot: RunLifecycleSnapshot): void | Promise<void>;
}

interface RunStageGroup {
  mode: "serial" | "parallel";
  stages: RunStage[];
}

interface RunStageGroupStart {
  entered: RunStage[];
  errors: unknown[];
}

/**
 * Registers serial and parallel stage groups, coordinates startup/termination,
 * and publishes snapshots. It owns ordering and cleanup, while stages own
 * their domain resources and failure details.
 */
export class RunStageExecutor {
  private readonly runId: string;
  private readonly logger: Logger;
  private readonly onStateChange?: RunStageExecutorOptions["onStateChange"];
  private readonly groups: RunStageGroup[] = [];
  private readonly stageSnapshots = new Map<string, RunStageSnapshot>();
  private readonly enteredGroups: RunStageGroup[] = [];
  private status: RunLifecycleStatus = "idle";
  private startupPromise?: Promise<void>;
  private terminationPromise?: Promise<void>;
  private resolveStartupTermination?: () => void;
  private terminationReason?: string;
  private terminationStartedAt?: number;

  constructor(options: RunStageExecutorOptions) {
    this.runId = options.runId;
    this.logger = options.logger;
    this.onStateChange = options.onStateChange;
  }

  registerSerial(...stages: RunStage[]): void {
    if (stages.length === 0) return;
    this.register({ mode: "serial", stages });
  }

  registerParallel(...stages: RunStage[]): void {
    if (stages.length === 0) return;
    this.register({ mode: "parallel", stages });
  }

  startup(): Promise<void> {
    if (this.startupPromise) return this.startupPromise;
    if (this.status !== "idle") {
      return Promise.reject(new Error(`Cannot start RunStageExecutor from ${this.status}.`));
    }
    this.startupPromise = Promise.resolve().then(() => this.runStartup());
    return this.startupPromise;
  }

  terminate(reason: string): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminationReason = reason;

    if (this.status === "starting") {
      const startedAt = Date.now();
      this.terminationStartedAt = startedAt;
      this.status = "terminating";
      this.logTerminationStarted(reason, startedAt);
      this.terminationPromise = new Promise<void>((resolve) => {
        this.resolveStartupTermination = resolve;
      });
      void this.emitSnapshot();
      return this.terminationPromise;
    }

    if (this.status === "terminating") {
      this.terminationPromise = Promise.resolve();
      return this.terminationPromise;
    }

    if (this.status === "terminated") {
      this.terminationPromise = Promise.resolve();
      return this.terminationPromise;
    }

    if (this.status === "failed") {
      this.terminationPromise = this.startupPromise
        ? this.startupPromise.then(() => undefined, () => undefined)
        : Promise.resolve();
      return this.terminationPromise;
    }

    this.terminationPromise = Promise.resolve().then(() => this.runTermination(reason));
    return this.terminationPromise;
  }

  snapshot(): RunLifecycleSnapshot {
    const stages = [...this.stageSnapshots.values()].map((stage) => ({ ...stage }));
    return {
      runId: this.runId,
      status: this.status,
      completedStages: stages.filter((stage) =>
        stage.status === "completed"
        || stage.status === "stopping"
        || stage.status === "stopped"
      ).length,
      totalStages: stages.length,
      stages,
      terminationReason: this.terminationReason,
    };
  }

  private register(group: RunStageGroup): void {
    if (this.status !== "idle" || this.startupPromise) {
      throw new Error("Run stages must be registered before startup.");
    }
    for (const stage of group.stages) {
      if (this.stageSnapshots.has(stage.id)) {
        throw new Error(`Duplicate run stage id: ${stage.id}`);
      }
      this.stageSnapshots.set(stage.id, {
        id: stage.id,
        status: "pending",
      });
    }
    this.groups.push({
      mode: group.mode,
      stages: [...group.stages],
    });
  }

  private async runStartup(): Promise<void> {
    const startedAt = Date.now();
    this.status = "starting";
    const progress = this.lifecycleProgress();
    this.logger.info({
      module: "run.lifecycle",
      event: "run_startup_started",
      message: `Run lifecycle startup began with ${progress.stageCount} registered stages.`,
      data: {
        stageCount: progress.stageCount,
        completedStages: progress.completedStages,
        remainingStages: progress.remainingStages,
        elapsedMs: 0,
      },
    });
    await this.emitSnapshot();

    for (const group of this.groups) {
      if (this.terminationReason) {
        await this.finishStartupTermination();
        throw new Error(`Run startup terminated: ${this.terminationReason}`);
      }

      const result = await this.startGroup(group, startedAt);
      if (result.entered.length > 0) {
        this.enteredGroups.push({
          mode: group.mode,
          stages: result.entered,
        });
      }
      if (result.errors.length > 0) {
        await this.failStartup(result.errors, startedAt);
        throw stageGroupError(result.errors);
      }
      if (this.terminationReason) {
        await this.finishStartupTermination();
        throw new Error(`Run startup terminated: ${this.terminationReason}`);
      }
    }

    this.status = "ready";
    const durationMs = Math.max(0, Date.now() - startedAt);
    const completedProgress = this.lifecycleProgress();
    this.logger.info({
      module: "run.lifecycle",
      event: "run_startup_completed",
      message: `Run lifecycle startup completed ${completedProgress.completedStages} stages in ${durationMs} ms.`,
      data: {
        durationMs,
        stageCount: completedProgress.stageCount,
        completedStages: completedProgress.completedStages,
        remainingStages: completedProgress.remainingStages,
        elapsedMs: durationMs,
      },
    });
    await this.emitSnapshot();
  }

  private async startGroup(
    group: RunStageGroup,
    lifecycleStartedAt: number,
  ): Promise<RunStageGroupStart> {
    if (group.mode === "parallel") {
      const settled = await Promise.allSettled(group.stages.map((stage) =>
        this.startStage(stage, group.mode, lifecycleStartedAt)
      ));
      return settled.reduce<RunStageGroupStart>((result, entry) => {
        if (entry.status === "rejected") {
          result.errors.push(entry.reason);
        }
        return result;
      }, { entered: [...group.stages], errors: [] });
    }

    const result: RunStageGroupStart = { entered: [], errors: [] };
    for (const stage of group.stages) {
      result.entered.push(stage);
      try {
        await this.startStage(stage, group.mode, lifecycleStartedAt);
        if (this.terminationReason) break;
      } catch (error) {
        result.errors.push(error);
        break;
      }
    }
    return result;
  }

  private async startStage(
    stage: RunStage,
    groupMode: RunStageGroup["mode"],
    lifecycleStartedAt: number,
  ): Promise<void> {
    const startedAt = Date.now();
    this.updateStage(stage.id, { status: "running", error: undefined });
    const position = this.stagePosition(stage.id);
    const startedProgress = this.lifecycleProgress();
    this.logger.info({
      module: "run.lifecycle",
      event: "run_stage_started",
      message: `Starting stage ${stage.id} (${position.stageIndex}/${position.stageCount}) in the ${groupMode} group.`,
      data: {
        stage: stage.id,
        ...position,
        groupMode,
        completedStages: startedProgress.completedStages,
        remainingStages: startedProgress.remainingStages,
        elapsedMs: Math.max(0, Date.now() - lifecycleStartedAt),
      },
    });
    await this.emitSnapshot();
    try {
      await stage.start();
      this.updateStage(stage.id, { status: "completed", error: undefined });
      const durationMs = Math.max(0, Date.now() - startedAt);
      const completedProgress = this.lifecycleProgress();
      this.logger.info({
        module: "run.lifecycle",
        event: "run_stage_completed",
        message: `Completed stage ${stage.id} (${completedProgress.completedStages}/${position.stageCount}); ${completedProgress.remainingStages} remain.`,
        data: {
          stage: stage.id,
          ...position,
          groupMode,
          durationMs,
          completedStages: completedProgress.completedStages,
          remainingStages: completedProgress.remainingStages,
          elapsedMs: Math.max(0, Date.now() - lifecycleStartedAt),
        },
      });
      await this.emitSnapshot();
    } catch (error) {
      const text = errorText(error);
      this.updateStage(stage.id, { status: "failed", error: text });
      const durationMs = Math.max(0, Date.now() - startedAt);
      const failedProgress = this.lifecycleProgress();
      this.logger.error({
        module: "run.lifecycle",
        event: "run_stage_failed",
        message: `Stage ${stage.id} failed after ${durationMs} ms; ${failedProgress.remainingStages} stages remain.`,
        data: {
          stage: stage.id,
          ...position,
          groupMode,
          durationMs,
          completedStages: failedProgress.completedStages,
          remainingStages: failedProgress.remainingStages,
          elapsedMs: Math.max(0, Date.now() - lifecycleStartedAt),
          error: text,
        },
      });
      await this.emitSnapshot();
      throw error;
    }
  }

  private async failStartup(errors: unknown[], lifecycleStartedAt: number): Promise<void> {
    const failedProgress = this.lifecycleProgress();
    const elapsedMs = Math.max(0, Date.now() - lifecycleStartedAt);
    this.status = "failed";
    await this.emitSnapshot();
    const stopReason = this.terminationReason ?? "startup_failed";
    const stopErrorCount = await this.stopEnteredGroups(
      stopReason,
      this.terminationStartedAt ?? lifecycleStartedAt,
    );
    if (this.terminationStartedAt !== undefined) {
      this.logTerminationCompleted(stopReason, stopErrorCount, this.terminationStartedAt);
    }
    this.logger.error({
      module: "run.lifecycle",
      event: "run_startup_failed",
      message: `Run lifecycle startup failed after ${elapsedMs} ms with ${errors.length} ${errors.length === 1 ? "error" : "errors"}.`,
      data: {
        errorCount: errors.length,
        stageCount: failedProgress.stageCount,
        completedStages: failedProgress.completedStages,
        remainingStages: failedProgress.remainingStages,
        elapsedMs,
      },
    });
    this.resolveStartupTermination?.();
    this.resolveStartupTermination = undefined;
  }

  private async finishStartupTermination(): Promise<void> {
    const reason = this.terminationReason ?? "termination_requested";
    const startedAt = this.terminationStartedAt ?? Date.now();
    const errorCount = await this.stopEnteredGroups(reason, startedAt);
    this.status = errorCount === 0 ? "terminated" : "failed";
    this.logTerminationCompleted(reason, errorCount, startedAt);
    await this.emitSnapshot();
    this.resolveStartupTermination?.();
    this.resolveStartupTermination = undefined;
  }

  private async runTermination(reason: string): Promise<void> {
    const startedAt = Date.now();
    this.terminationStartedAt = startedAt;
    this.status = "terminating";
    this.logTerminationStarted(reason, startedAt);
    await this.emitSnapshot();
    const errorCount = await this.stopEnteredGroups(reason, startedAt);
    this.status = errorCount === 0 ? "terminated" : "failed";
    this.logTerminationCompleted(reason, errorCount, startedAt);
    await this.emitSnapshot();
  }

  private async stopEnteredGroups(reason: string, lifecycleStartedAt: number): Promise<number> {
    let errorCount = 0;
    for (const group of [...this.enteredGroups].reverse()) {
      if (group.mode === "parallel") {
        const settled = await Promise.allSettled(group.stages.map((stage) =>
          this.stopStage(stage, reason, group.mode, lifecycleStartedAt)
        ));
        errorCount += settled.filter((entry) => entry.status === "rejected").length;
        continue;
      }
      for (const stage of [...group.stages].reverse()) {
        try {
          await this.stopStage(stage, reason, group.mode, lifecycleStartedAt);
        } catch {
          errorCount += 1;
        }
      }
    }
    this.enteredGroups.length = 0;
    return errorCount;
  }

  private async stopStage(
    stage: RunStage,
    reason: string,
    groupMode: RunStageGroup["mode"],
    lifecycleStartedAt: number,
  ): Promise<void> {
    const current = this.stageSnapshots.get(stage.id);
    if (!current || current.status === "stopped") return;
    const startedAt = Date.now();
    const position = this.stagePosition(stage.id);
    this.updateStage(stage.id, { status: "stopping", error: undefined });
    await this.emitSnapshot();
    try {
      await stage.stop?.(reason);
      this.updateStage(stage.id, { status: "stopped", error: undefined });
      const durationMs = Math.max(0, Date.now() - startedAt);
      this.logger.info({
        module: "run.lifecycle",
        event: "run_stage_stopped",
        message: `Stopped stage ${stage.id} in ${durationMs} ms because ${reason}.`,
        data: {
          stage: stage.id,
          reason,
          ...position,
          groupMode,
          durationMs,
          elapsedMs: Math.max(0, Date.now() - lifecycleStartedAt),
        },
      });
      await this.emitSnapshot();
    } catch (error) {
      const text = errorText(error);
      this.updateStage(stage.id, { status: "failed", error: text });
      const durationMs = Math.max(0, Date.now() - startedAt);
      this.logger.error({
        module: "run.lifecycle",
        event: "run_stage_stop_failed",
        message: `Stage ${stage.id} failed to stop after ${durationMs} ms because ${reason}.`,
        data: {
          stage: stage.id,
          reason,
          ...position,
          groupMode,
          durationMs,
          elapsedMs: Math.max(0, Date.now() - lifecycleStartedAt),
          error: text,
        },
      });
      await this.emitSnapshot();
      throw error;
    }
  }

  private updateStage(
    stageId: string,
    update: Pick<RunStageSnapshot, "status" | "error">,
  ): void {
    const current = this.stageSnapshots.get(stageId);
    if (!current) throw new Error(`Unknown run stage: ${stageId}`);
    this.stageSnapshots.set(stageId, {
      ...current,
      status: update.status,
      ...(update.error ? { error: update.error } : {}),
    });
  }

  private async emitSnapshot(): Promise<void> {
    if (!this.onStateChange) return;
    try {
      await this.onStateChange(this.snapshot());
    } catch (error) {
      this.logger.warn({
        module: "run.lifecycle",
        event: "run_lifecycle_state_publish_failed",
        message: `Failed to publish the ${this.status} run lifecycle snapshot.`,
        data: { error: errorText(error) },
      });
    }
  }

  private lifecycleProgress(): {
    stageCount: number;
    completedStages: number;
    remainingStages: number;
  } {
    const snapshot = this.snapshot();
    return {
      stageCount: snapshot.totalStages,
      completedStages: snapshot.completedStages,
      remainingStages: Math.max(0, snapshot.totalStages - snapshot.completedStages),
    };
  }

  private stagePosition(stageId: string): { stageIndex: number; stageCount: number } {
    const stageIds = [...this.stageSnapshots.keys()];
    const stageIndex = stageIds.indexOf(stageId);
    if (stageIndex < 0) throw new Error(`Unknown run stage: ${stageId}`);
    return {
      stageIndex: stageIndex + 1,
      stageCount: stageIds.length,
    };
  }

  private logTerminationStarted(reason: string, startedAt: number): void {
    const progress = this.lifecycleProgress();
    this.logger.info({
      module: "run.lifecycle",
      event: "run_termination_started",
      message: `Run termination started because ${reason}; ${progress.completedStages}/${progress.stageCount} stages had completed.`,
      data: {
        reason,
        stageCount: progress.stageCount,
        completedStages: progress.completedStages,
        remainingStages: progress.remainingStages,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      },
    });
  }

  private logTerminationCompleted(reason: string, errorCount: number, startedAt: number): void {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const progress = this.lifecycleProgress();
    this.logger.info({
      module: "run.lifecycle",
      event: "run_termination_completed",
      message: `Run termination completed in ${durationMs} ms with ${errorCount} ${errorCount === 1 ? "stop error" : "stop errors"}.`,
      data: {
        reason,
        errorCount,
        durationMs,
        stageCount: progress.stageCount,
        completedStages: progress.completedStages,
        remainingStages: progress.remainingStages,
        elapsedMs: durationMs,
      },
    });
  }
}

function stageGroupError(errors: unknown[]): Error {
  if (errors.length === 1) {
    const error = errors[0];
    return error instanceof Error ? error : new Error(String(error));
  }
  return new AggregateError(errors, `${errors.length} run stages failed.`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

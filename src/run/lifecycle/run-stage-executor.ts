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
      this.status = "terminating";
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
    this.logger.info({
      module: "run.lifecycle",
      event: "run_startup_started",
      data: {
        stageCount: this.stageSnapshots.size,
      },
    });
    await this.emitSnapshot();

    for (const group of this.groups) {
      if (this.terminationReason) {
        await this.finishStartupTermination();
        throw new Error(`Run startup terminated: ${this.terminationReason}`);
      }

      const result = await this.startGroup(group);
      if (result.entered.length > 0) {
        this.enteredGroups.push({
          mode: group.mode,
          stages: result.entered,
        });
      }
      if (result.errors.length > 0) {
        await this.failStartup(result.errors);
        throw stageGroupError(result.errors);
      }
      if (this.terminationReason) {
        await this.finishStartupTermination();
        throw new Error(`Run startup terminated: ${this.terminationReason}`);
      }
    }

    this.status = "ready";
    this.logger.info({
      module: "run.lifecycle",
      event: "run_startup_completed",
      data: {
        durationMs: Math.max(0, Date.now() - startedAt),
        stageCount: this.stageSnapshots.size,
      },
    });
    await this.emitSnapshot();
  }

  private async startGroup(group: RunStageGroup): Promise<RunStageGroupStart> {
    if (group.mode === "parallel") {
      const settled = await Promise.allSettled(group.stages.map((stage) => this.startStage(stage)));
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
        await this.startStage(stage);
        if (this.terminationReason) break;
      } catch (error) {
        result.errors.push(error);
        break;
      }
    }
    return result;
  }

  private async startStage(stage: RunStage): Promise<void> {
    const startedAt = Date.now();
    this.updateStage(stage.id, { status: "running", error: undefined });
    this.logger.info({
      module: "run.lifecycle",
      event: "run_stage_started",
      data: { stage: stage.id },
    });
    await this.emitSnapshot();
    try {
      await stage.start();
      this.updateStage(stage.id, { status: "completed", error: undefined });
      this.logger.info({
        module: "run.lifecycle",
        event: "run_stage_completed",
        data: {
          stage: stage.id,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      });
      await this.emitSnapshot();
    } catch (error) {
      const text = errorText(error);
      this.updateStage(stage.id, { status: "failed", error: text });
      this.logger.error({
        module: "run.lifecycle",
        event: "run_stage_failed",
        data: {
          stage: stage.id,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: text,
        },
      });
      await this.emitSnapshot();
      throw error;
    }
  }

  private async failStartup(errors: unknown[]): Promise<void> {
    this.status = "failed";
    await this.emitSnapshot();
    await this.stopEnteredGroups(this.terminationReason ?? "startup_failed");
    this.logger.error({
      module: "run.lifecycle",
      event: "run_startup_failed",
      data: {
        errorCount: errors.length,
      },
    });
    this.resolveStartupTermination?.();
    this.resolveStartupTermination = undefined;
  }

  private async finishStartupTermination(): Promise<void> {
    const reason = this.terminationReason ?? "termination_requested";
    const errorCount = await this.stopEnteredGroups(reason);
    this.status = errorCount === 0 ? "terminated" : "failed";
    await this.emitSnapshot();
    this.resolveStartupTermination?.();
    this.resolveStartupTermination = undefined;
  }

  private async runTermination(reason: string): Promise<void> {
    const startedAt = Date.now();
    this.status = "terminating";
    this.logger.info({
      module: "run.lifecycle",
      event: "run_termination_started",
      data: { reason },
    });
    await this.emitSnapshot();
    const errorCount = await this.stopEnteredGroups(reason);
    this.status = errorCount === 0 ? "terminated" : "failed";
    this.logger.info({
      module: "run.lifecycle",
      event: "run_termination_completed",
      data: {
        reason,
        errorCount,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    });
    await this.emitSnapshot();
  }

  private async stopEnteredGroups(reason: string): Promise<number> {
    let errorCount = 0;
    for (const group of [...this.enteredGroups].reverse()) {
      if (group.mode === "parallel") {
        const settled = await Promise.allSettled(group.stages.map((stage) =>
          this.stopStage(stage, reason)
        ));
        errorCount += settled.filter((entry) => entry.status === "rejected").length;
        continue;
      }
      for (const stage of [...group.stages].reverse()) {
        try {
          await this.stopStage(stage, reason);
        } catch {
          errorCount += 1;
        }
      }
    }
    this.enteredGroups.length = 0;
    return errorCount;
  }

  private async stopStage(stage: RunStage, reason: string): Promise<void> {
    const current = this.stageSnapshots.get(stage.id);
    if (!current || current.status === "stopped") return;
    this.updateStage(stage.id, { status: "stopping", error: undefined });
    await this.emitSnapshot();
    try {
      await stage.stop?.(reason);
      this.updateStage(stage.id, { status: "stopped", error: undefined });
      this.logger.info({
        module: "run.lifecycle",
        event: "run_stage_stopped",
        data: { stage: stage.id, reason },
      });
      await this.emitSnapshot();
    } catch (error) {
      const text = errorText(error);
      this.updateStage(stage.id, { status: "failed", error: text });
      this.logger.error({
        module: "run.lifecycle",
        event: "run_stage_stop_failed",
        data: {
          stage: stage.id,
          reason,
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
        data: { error: errorText(error) },
      });
    }
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

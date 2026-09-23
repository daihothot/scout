import {
  ScoutExecutionSystem,
  type ScoutExecutionSystemStartOptions,
} from "../../../execution/scout-execution-system.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Composes the run-scoped execution system without probing an external platform. */
export class ExecutionStage implements RunStage {
  readonly id = "execution";
  private system?: ScoutExecutionSystem;

  constructor(
    private readonly startExecutionSystem: (
      options: ScoutExecutionSystemStartOptions,
    ) => Promise<ScoutExecutionSystem> = ScoutExecutionSystem.start,
  ) {}

  async start(): Promise<void> {
    const scope = currentRunScope();
    const system = await this.startExecutionSystem({ cwd: scope.scoutRoot });
    try {
      scope.setExecutionSystem(system);
      this.system = system;
    } catch (error) {
      await system.dispose();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const system = this.system;
    if (!system) return;
    try {
      await system.dispose();
    } finally {
      currentRunScope().clearExecutionSystem(system);
      this.system = undefined;
    }
  }
}

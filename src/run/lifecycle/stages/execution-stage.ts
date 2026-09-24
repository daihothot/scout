import {
  ScoutExecutionSystem,
} from "../../../execution/scout-execution-system.js";
import type { EventBus } from "../../../core/events/index.js";
import {
  AppPilotExecutionHandler,
  type AppPilotExecutionHandlerOptions,
} from "../../../execution/handlers/apppilot/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Composes the run-scoped execution system without probing an external platform. */
export class ExecutionStage implements RunStage {
  readonly id = "execution";
  private system?: ScoutExecutionSystem;

  constructor(
    private readonly startExecutionSystem: (
      options: AppPilotExecutionHandlerOptions,
      eventBus: EventBus,
    ) => Promise<ScoutExecutionSystem> = (options, eventBus) => ScoutExecutionSystem.start(
      new AppPilotExecutionHandler(options),
      eventBus,
    ),
  ) {}

  async start(): Promise<void> {
    const scope = currentRunScope();
    const system = await this.startExecutionSystem({ cwd: scope.scoutRoot }, scope.eventBus);
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

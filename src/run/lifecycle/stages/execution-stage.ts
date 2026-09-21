import { ExecutionAdapterRegistry } from "../../../execution/execution-adapter-registry.js";
import { ScoutExecutionSystem } from "../../../execution/scout-execution-system.js";
import { UnityPipelineExecutionAdapter } from "../../../execution/transports/unity-pipeline/unity-pipeline-execution-adapter.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Composes the run-scoped execution system without probing an external platform. */
export class ExecutionStage implements RunStage {
  readonly id = "execution";
  private system?: ScoutExecutionSystem;

  async start(): Promise<void> {
    const system = new ScoutExecutionSystem(new ExecutionAdapterRegistry([
      new UnityPipelineExecutionAdapter(),
    ]));
    currentRunScope().setExecutionSystem(system);
    this.system = system;
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

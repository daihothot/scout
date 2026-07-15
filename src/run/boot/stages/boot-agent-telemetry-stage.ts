import {
  AgentActivityRecorder,
  TaskEventRecorder,
} from "../../../agent/telemetry/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { BootStage } from "../boot-stage.js";

export class BootAgentTelemetryStage implements BootStage {
  readonly id = "agent_telemetry";
  private taskRecorder?: TaskEventRecorder;
  private activityRecorder?: AgentActivityRecorder;

  async start(): Promise<void> {
    const scope = currentRunScope();
    const taskRecorder = new TaskEventRecorder({
      runId: scope.runId,
      eventBus: scope.eventBus,
      registry: scope.agentRegistry,
    });
    const activityRecorder = new AgentActivityRecorder({
      runId: scope.runId,
      eventBus: scope.eventBus,
      registry: scope.agentRegistry,
    });
    taskRecorder.start();
    try {
      activityRecorder.start();
    } catch (error) {
      taskRecorder.stop();
      throw error;
    }
    this.taskRecorder = taskRecorder;
    this.activityRecorder = activityRecorder;
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    try {
      this.activityRecorder?.stop();
    } catch (error) {
      errors.push(error);
    }
    this.activityRecorder = undefined;
    try {
      this.taskRecorder?.stop();
    } catch (error) {
      errors.push(error);
    }
    this.taskRecorder = undefined;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Agent telemetry recorders failed to stop.");
    }
  }
}

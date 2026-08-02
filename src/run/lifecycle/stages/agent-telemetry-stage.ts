import {
  AgentActivityRecorder,
  AgentSkillRecorder,
  AgentThreadRecorder,
  TaskEventRecorder,
} from "../../../agent/telemetry/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

export class AgentTelemetryStage implements RunStage {
  readonly id = "agent_telemetry";
  private taskRecorder?: TaskEventRecorder;
  private activityRecorder?: AgentActivityRecorder;
  private skillRecorder?: AgentSkillRecorder;
  private threadRecorder?: AgentThreadRecorder;

  async start(): Promise<void> {
    const taskRecorder = new TaskEventRecorder();
    const activityRecorder = new AgentActivityRecorder();
    const skillRecorder = new AgentSkillRecorder();
    const threadRecorder = new AgentThreadRecorder();
    threadRecorder.start();
    try {
      taskRecorder.start();
      try {
        activityRecorder.start();
        try {
          skillRecorder.start();
        } catch (error) {
          activityRecorder.stop();
          throw error;
        }
      } catch (error) {
        taskRecorder.stop();
        throw error;
      }
    } catch (error) {
      threadRecorder.stop();
      throw error;
    }
    this.threadRecorder = threadRecorder;
    this.taskRecorder = taskRecorder;
    this.activityRecorder = activityRecorder;
    this.skillRecorder = skillRecorder;
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    try {
      this.skillRecorder?.stop();
    } catch (error) {
      errors.push(error);
    }
    this.skillRecorder = undefined;
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
    try {
      this.threadRecorder?.stop();
    } catch (error) {
      errors.push(error);
    }
    this.threadRecorder = undefined;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Agent telemetry recorders failed to stop.");
    }
  }
}

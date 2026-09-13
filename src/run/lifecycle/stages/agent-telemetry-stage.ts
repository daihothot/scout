import {
  AgentActivityRecorder,
  AgentCommandExecutionRecorder,
  AgentHumanInputRecorder,
  AgentSubagentRecorder,
  AgentThreadRecorder,
  AgentToolCallRecorder,
  StepEventRecorder,
  TaskEventRecorder,
} from "../../../agent/telemetry/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Installs and reverses the event recorders that persist agent telemetry. */
export class AgentTelemetryStage implements RunStage {
  readonly id = "agent_telemetry";
  private taskRecorder?: TaskEventRecorder;
  private stepRecorder?: StepEventRecorder;
  private activityRecorder?: AgentActivityRecorder;
  private subagentRecorder?: AgentSubagentRecorder;
  private commandExecutionRecorder?: AgentCommandExecutionRecorder;
  private threadRecorder?: AgentThreadRecorder;
  private humanInputRecorder?: AgentHumanInputRecorder;
  private toolCallRecorder?: AgentToolCallRecorder;

  async start(): Promise<void> {
    const taskRecorder = new TaskEventRecorder();
    const stepRecorder = new StepEventRecorder();
    const activityRecorder = new AgentActivityRecorder();
    const subagentRecorder = new AgentSubagentRecorder();
    const commandExecutionRecorder = new AgentCommandExecutionRecorder();
    const threadRecorder = new AgentThreadRecorder();
    const humanInputRecorder = new AgentHumanInputRecorder();
    const toolCallRecorder = new AgentToolCallRecorder();
    threadRecorder.start();
    try {
      taskRecorder.start();
      try {
        stepRecorder.start();
        try {
          activityRecorder.start();
          try {
            subagentRecorder.start();
            commandExecutionRecorder.start();
            humanInputRecorder.start();
            toolCallRecorder.start();
          } catch (error) {
            subagentRecorder.stop();
            throw error;
          }
        } catch (error) {
          toolCallRecorder.stop();
          humanInputRecorder.stop();
          commandExecutionRecorder.stop();
          activityRecorder.stop();
          stepRecorder.stop();
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
    this.stepRecorder = stepRecorder;
    this.activityRecorder = activityRecorder;
    this.subagentRecorder = subagentRecorder;
    this.commandExecutionRecorder = commandExecutionRecorder;
    this.humanInputRecorder = humanInputRecorder;
    this.toolCallRecorder = toolCallRecorder;
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
      this.subagentRecorder?.stop();
    } catch (error) {
      errors.push(error);
    }
    this.subagentRecorder = undefined;
    try {
      this.commandExecutionRecorder?.stop();
    } catch (error) {
      errors.push(error);
    }
    this.commandExecutionRecorder = undefined;
    try {
      this.humanInputRecorder?.stop();
    } catch (error) {
      errors.push(error);
    }
    this.humanInputRecorder = undefined;
    try {
      this.toolCallRecorder?.stop();
    } catch (error) {
      errors.push(error);
    }
    this.toolCallRecorder = undefined;
    try {
      this.stepRecorder?.stop();
    } catch (error) {
      errors.push(error);
    }
    this.stepRecorder = undefined;
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

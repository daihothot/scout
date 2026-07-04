import type {
  AgentHumanInputRequest,
  AgentHumanInputResponse,
  AgentTaskState,
  AssignAgentTaskInput,
  SendAgentMessageInput,
} from "../task/types.js";

export type AgentRunnerKind = "coordinator" | "worker";

export interface AgentRunnerSnapshot {
  tasks: AgentTaskState[];
  activeTask?: AgentTaskState;
  pendingMessageCount: number;
}

export abstract class AgentRunner {
  abstract readonly runnerKind: AgentRunnerKind;
  abstract readonly agentId: string;

  snapshot(): AgentRunnerSnapshot {
    return {
      tasks: [],
      pendingMessageCount: 0,
    };
  }

  stop(_reason?: string): void | Promise<void> {
    return undefined;
  }

  assignTask(_input: AssignAgentTaskInput): AgentTaskState {
    return this.unsupportedTaskMethod("assignTask");
  }

  queueMessage(_input: Omit<SendAgentMessageInput, "target"> & { taskId?: string }): AgentTaskState {
    return this.unsupportedTaskMethod("queueMessage");
  }

  stopTask(_taskId: string, _reason?: string): AgentTaskState {
    return this.unsupportedTaskMethod("stopTask");
  }

  requestHumanInput(input: {
    taskId: string;
    request: AgentHumanInputRequest;
  }): AgentTaskState {
    void input;
    return this.unsupportedTaskMethod("requestHumanInput");
  }

  applyHumanInputResponse(_input: AgentHumanInputResponse): AgentTaskState {
    return this.unsupportedTaskMethod("applyHumanInputResponse");
  }

  hasRunningTasks(): boolean {
    return false;
  }

  private unsupportedTaskMethod(method: string): never {
    throw new Error(`Agent runner ${this.agentId} (${this.runnerKind}) does not support ${method}.`);
  }
}

import type { AgentTaskState } from "../task/types.js";

export type AgentRunnerKind = "coordinator" | "worker";

export interface AgentRunnerSnapshot {
  activeTask?: AgentTaskState;
  pendingMessageCount: number;
}

export abstract class AgentRunner {
  abstract readonly runnerKind: AgentRunnerKind;
  abstract readonly agentId: string;

  snapshot(): AgentRunnerSnapshot {
    return {
      pendingMessageCount: 0,
    };
  }

  stop(_reason?: string): void | Promise<void> {
    return undefined;
  }

  stopTask(_taskId: string, _reason?: string): Promise<AgentTaskState> {
    return this.unsupportedTaskMethod("stopTask");
  }

  private unsupportedTaskMethod(method: string): never {
    throw new Error(`Agent runner ${this.agentId} (${this.runnerKind}) does not support ${method}.`);
  }
}

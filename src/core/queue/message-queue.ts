export type RuntimeQueuedCommandPriority = "now" | "next" | "later";

export interface RuntimeQueuedCommand {
  id: string;
  type: "user_input" | "task_notification" | "system_event";
  priority: RuntimeQueuedCommandPriority;
  enqueuedAt: string;
  payload: string;
  sourceTaskId?: string;
}

export interface EnqueueRuntimeCommandInput {
  type: RuntimeQueuedCommand["type"];
  payload: string;
  priority?: RuntimeQueuedCommandPriority;
  sourceTaskId?: string;
}

export class RuntimeMessageQueueManager {
  private readonly commandQueue: RuntimeQueuedCommand[] = [];
  private sequence = 0;

  enqueue(input: EnqueueRuntimeCommandInput): RuntimeQueuedCommand {
    const command: RuntimeQueuedCommand = {
      id: `queued-command-${String(++this.sequence).padStart(4, "0")}`,
      type: input.type,
      priority: input.priority ?? defaultPriorityForCommand(input.type),
      enqueuedAt: new Date().toISOString(),
      payload: input.payload,
      sourceTaskId: input.sourceTaskId,
    };
    this.commandQueue.push(command);
    return command;
  }

  dequeue(): RuntimeQueuedCommand | undefined {
    if (this.commandQueue.length === 0) return undefined;
    const index = this.commandQueue
      .map((command, queueIndex) => ({ command, queueIndex }))
      .sort((left, right) => {
        const priorityDelta = priorityRank(left.command.priority) - priorityRank(right.command.priority);
        if (priorityDelta !== 0) return priorityDelta;
        return left.queueIndex - right.queueIndex;
      })[0]?.queueIndex;
    if (typeof index !== "number") return undefined;
    const [command] = this.commandQueue.splice(index, 1);
    return command;
  }

  drain(): RuntimeQueuedCommand[] {
    const drained: RuntimeQueuedCommand[] = [];
    let next = this.dequeue();
    while (next) {
      drained.push(next);
      next = this.dequeue();
    }
    return drained;
  }

  snapshot(): RuntimeQueuedCommand[] {
    return [...this.commandQueue];
  }
}

export const runtimeMessageQueueManager = new RuntimeMessageQueueManager();

function defaultPriorityForCommand(type: RuntimeQueuedCommand["type"]): RuntimeQueuedCommandPriority {
  if (type === "task_notification") return "later";
  return "next";
}

function priorityRank(priority: RuntimeQueuedCommandPriority): number {
  if (priority === "now") return 0;
  if (priority === "next") return 1;
  return 2;
}

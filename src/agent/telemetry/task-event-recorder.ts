import type {
  EventBus,
  ScoutEvent,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { AgentEvents } from "../events/index.js";
import type { AgentRegistry } from "../core/agent-registry.js";
import type { AgentTaskNotAssignedEventPayload } from "../task/task-events.js";
import type { AgentTaskState } from "../task/types.js";

export interface TaskEventRecorderOptions {
  runId: string;
  eventBus: EventBus;
  registry: AgentRegistry;
}

export class TaskEventRecorder {
  private readonly runId: string;
  private readonly eventBus: EventBus;
  private readonly registry: AgentRegistry;
  private readonly taskLoggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  constructor(options: TaskEventRecorderOptions) {
    this.runId = options.runId;
    this.eventBus = options.eventBus;
    this.registry = options.registry;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe(AgentEvents.task, (event) => {
      this.record(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.taskLoggers.clear();
  }

  private record(event: ScoutEvent): void {
    if (AgentEvents.task.notAssigned.is(event)) {
      const rejection = event.payload as AgentTaskNotAssignedEventPayload;
      this.write(event, rejection.agentId, rejection.activeTaskId, rejection);
      return;
    }
    const task = event.payload as AgentTaskState;
    this.write(event, task.agentId, task.taskId, task);
  }

  private write(
    event: ScoutEvent,
    agentId: string,
    taskId: string,
    data: AgentTaskState | AgentTaskNotAssignedEventPayload,
  ): void {
    this.loggerFor(agentId, taskId).info({
      module: "agent.task",
      event: event.key.routeKey,
      agentId,
      taskId,
      data,
    });
  }

  private loggerFor(agentId: string, taskId: string): Logger {
    const key = `${agentId}:${taskId}`;
    const existing = this.taskLoggers.get(key);
    if (existing) return existing;
    const agent = this.registry.resolveAgent(agentId);
    const logger = new Logger({
      runId: this.runId,
      logsRoot: agent.mount.logsRoot,
      fileName: `${safeTaskId(taskId)}.log`,
    });
    this.taskLoggers.set(key, logger);
    return logger;
  }
}

function safeTaskId(taskId: string): string {
  const safe = taskId.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "unknown-task";
}

import type {
  ScoutEvent,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentTaskNotAssignedEventPayload } from "../task/task-events.js";
import type { AgentTaskState } from "../task/types.js";
import {
  AGENT_FIND_SKILLS_TOOL_NAMESPACE,
  AGENT_READ_SKILL_RESOURCE_TOOL_NAMESPACE,
} from "../tools/agent-tools.js";

/** Writes task lifecycle events to the owning agent's task log. */
export class TaskEventRecorder {
  private readonly taskLoggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(AgentEvents.task, (event) => {
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
      this.write(event, rejection.agentId, rejection.activeTaskId, { ...rejection });
      return;
    }
    if (AgentEvents.task.dispositionRecorded.is(event)) {
      const { task, disposition } = event.payload;
      this.write(event, task.agentId, task.taskId, { ...disposition });
      return;
    }
    if (AgentEvents.task.outcomeSubmitted.is(event)) {
      const submission = event.payload;
      this.write(event, submission.task.agentId, submission.task.taskId, {
        stepId: submission.stepId,
        turnId: submission.turnId,
        callId: submission.callId,
        status: submission.task.status,
        outcome: submission.outcome,
        submittedAt: submission.submittedAt,
      });
      return;
    }
    const task = event.payload as AgentTaskState;
    if (AgentEvents.task.assigned.is(event)) {
      this.write(event, task.agentId, task.taskId, {
        taskSequence: task.taskSequence,
        role: task.role,
        description: task.description,
        initialPrompt: task.initialPrompt,
        status: task.status,
        isBackgrounded: task.isBackgrounded,
        createdAt: task.createdAt,
      });
      return;
    }
    if (AgentEvents.task.messageQueued.is(event)) {
      this.write(event, task.agentId, task.taskId, {
        status: task.status,
        updatedAt: task.updatedAt,
      });
      return;
    }
    if (AgentEvents.task.done.is(event)) {
      this.write(event, task.agentId, task.taskId, {
        status: task.status,
        updatedAt: task.updatedAt,
      });
      return;
    }
    if (AgentEvents.task.archived.is(event)) {
      this.write(event, task.agentId, task.taskId, {
        status: task.status,
        archivedAt: event.occurredAt,
      });
      return;
    }
    if (AgentEvents.task.stopped.is(event)) {
      this.write(event, task.agentId, task.taskId, {
        status: task.status,
        error: task.error,
        finishedAt: task.finishedAt,
        updatedAt: task.updatedAt,
      });
      return;
    }
    if (AgentEvents.task.pendingMessagesDrained.is(event)) {
      this.write(event, task.agentId, task.taskId, {
        status: task.status,
        updatedAt: task.updatedAt,
      });
      return;
    }
    if (AgentEvents.task.stepStarted.is(event)) {
      const step = task.steps?.at(-1);
      this.write(event, task.agentId, task.taskId, {
        stepId: step?.stepId,
        status: step?.status,
        prompt: step?.prompt,
        startedAt: step?.startedAt,
        humanInputResponse: step?.humanInputResponse,
      });
      return;
    }
    if (AgentEvents.task.stepCompleted.is(event)) {
      const step = task.steps?.at(-1);
      this.write(event, task.agentId, task.taskId, {
        stepId: step?.stepId,
        turnId: step?.turnId,
        status: step?.status,
        finalResponse: step?.finalResponse,
        // Skill discovery/read facts have their own skill.log; keep the task
        // projection focused on calls that do not have a dedicated recorder.
        toolCalls: step?.toolCalls.filter((toolCall) =>
          toolCall.namespace !== AGENT_FIND_SKILLS_TOOL_NAMESPACE
          && toolCall.namespace !== AGENT_READ_SKILL_RESOURCE_TOOL_NAMESPACE
        ),
        humanInputRequest: step?.humanInputRequest,
        finishedAt: step?.finishedAt,
        durationMs: step?.durationMs,
        protocolWarnings: step?.protocolWarnings,
        error: step?.error,
      });
      return;
    }
    if (AgentEvents.task.failed.is(event)) {
      this.write(event, task.agentId, task.taskId, {
        status: task.status,
        error: task.error,
        finishedAt: task.finishedAt,
        updatedAt: task.updatedAt,
      });
      return;
    }
    if (AgentEvents.task.planUpdated.is(event)) {
      this.write(event, task.agentId, task.taskId, task.plan ?? {});
      return;
    }
    if (AgentEvents.task.terminal.is(event)) {
      this.write(event, task.agentId, task.taskId, {
        status: task.status,
        error: task.error,
        finishedAt: task.finishedAt,
      });
    }
  }

  private write(
    event: ScoutEvent,
    agentId: string,
    taskId: string,
    data: object,
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
    const scope = currentRunScope();
    const agent = scope.agentRegistry.resolveAgent(agentId);
    const logger = new Logger({
      runId: scope.runId,
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

import {
  AgentTaskStatuses,
  type AgentTaskState,
} from "../../../agent/task/types.js";
import type {
  AgentThreadSnapshot,
  ScoutAgentRole,
} from "../../../agent/thread/types.js";
import { AgentEvents } from "../../../agent/events/index.js";
import type { AgentHumanInputState } from "../../../agent/human-input/index.js";
import type { AgentMessage } from "../../../agent/message/types.js";
import type { AgentStepState } from "../../../agent/step/types.js";
import type { AgentToolCallState } from "../../../agent/tool-call/types.js";
import type {
  ScoutDomainArtifactFact,
  ScoutDomainGateFact,
  ScoutDomainJournalProjection,
} from "../../../domain/types.js";
import { SystemEvents } from "../../../system/events/index.js";
import { RunEvents } from "../../events/index.js";
import type { RunJournalEvent } from "../../journal/index.js";
import {
  applyTaskJournalEvent,
  type ProjectedArchivedTask,
} from "./task-projector.js";

/** Human-input state retained under the projection's recovery namespace. */
export type ProjectedHumanInputRequest = AgentHumanInputState;

/** Folded lifecycle state for one agent-server turn. */
export interface ProjectedTurn {
  invocationId: string;
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  prompt: string;
  startedSeq: number;
  startedAt: string;
  completedSeq?: number;
  completedAt?: string;
  status?: "completed" | "failed" | "interrupted";
  error?: string;
}

/** Durable task outcome facts used when deciding post-submit recovery. */
export interface ProjectedTaskOutcome {
  taskId: string;
  agentId: string;
  stepId: string;
  outcome: string;
  journalSeq: number;
  submittedAt: string;
}

/** Published artifact identity and verification facts, without artifact body. */
export interface ProjectedArtifact extends ScoutDomainArtifactFact {
  journalSeq: number;
}

/** Validation gate fact retained for coordinator review during resume. */
export interface ProjectedGate extends ScoutDomainGateFact {
  journalSeq: number;
}

/**
 * Read model derived from the run journal at a single checkpoint. It combines
 * active and archived tasks, thread state, deliveries, human-input requests,
 * turns, outcomes, artifacts, and gates; it is not a second source of truth
 * and does not perform runtime restoration.
 */
export interface RunProjection {
  runId: string;
  checkpointSeq: number;
  threads: AgentThreadSnapshot[];
  tasks: AgentTaskState[];
  archivedTasks: ProjectedArchivedTask[];
  messageDeliveries: AgentMessage[];
  pendingMessages: AgentMessage[];
  humanInputRequests: ProjectedHumanInputRequest[];
  turns: ProjectedTurn[];
  steps: AgentStepState[];
  toolCalls: AgentToolCallState[];
  taskOutcomes: ProjectedTaskOutcome[];
  artifacts: ProjectedArtifact[];
  gates: ProjectedGate[];
  userMessages: Array<{
    messageId: string;
    text: string;
    attachment: string;
    acceptedAt: string;
    seq: number;
  }>;
  coordinatorMessages: Array<{
    messageId: string;
    text: string;
    createdAt: string;
    seq: number;
  }>;
}

/**
 * Folds ordered journal events into a recovery read model. The projector
 * validates required starts and matching identifiers, preserves the last
 * journal sequence as the checkpoint, and fails on contradictory facts rather
 * than inventing state. It is read-only with respect to the journal.
 */
export function projectRun(
  events: RunJournalEvent[],
  synthesisRole: string,
  domainJournal?: ScoutDomainJournalProjection,
): RunProjection {
  const created = events.find((event) => RunEvents.run.created.is(event));
  if (!created || !RunEvents.run.created.is(created)) {
    throw new Error("Run journal is missing run.created.");
  }
  const tasks = new Map<string, AgentTaskState>();
  const archivedTasks = new Map<string, ProjectedArchivedTask>();
  const threads = new Map<string, AgentThreadSnapshot>();
  const queuedMessages = new Map<string, AgentMessage>();
  const queuedMessageSeq = new Map<string, number>();
  const recoveryMessages = new Map<string, AgentMessage>();
  const recoveryMessageSeq = new Map<string, number>();
  const recoveryMessageTask = new Map<string, string>();
  const consumedMessages = new Set<string>();
  const humanRequests = new Map<string, ProjectedHumanInputRequest>();
  const turns = new Map<string, ProjectedTurn>();
  const steps = new Map<string, AgentStepState>();
  const toolCalls = new Map<string, AgentToolCallState>();
  const outcomes: ProjectedTaskOutcome[] = [];
  const artifacts: ProjectedArtifact[] = [];
  const gates: ProjectedGate[] = [];
  const userMessages: RunProjection["userMessages"] = [];
  const coordinatorMessages: RunProjection["coordinatorMessages"] = [];

  for (const event of events) {
    if (AgentEvents.thread.started.is(event)) {
      threads.set(event.payload.agentId, structuredClone(event.payload));
      continue;
    }
    if (AgentEvents.thread.resumed.is(event)) {
      const existing = threads.get(event.payload.agentId);
      if (!existing || existing.threadId !== event.payload.threadId) {
        throw new Error(
          `Thread resumed without matching start: ${event.payload.threadId}`,
        );
      }
      threads.set(event.payload.agentId, {
        agentId: existing.agentId,
        role: existing.role,
        phases: [...existing.phases],
        contextBundleId: existing.contextBundleId,
        threadId: existing.threadId,
        createdAt: existing.createdAt,
        status: "active",
        startInput: structuredClone(existing.startInput),
        startResponse: structuredClone(existing.startResponse),
      });
      continue;
    }
    if (AgentEvents.thread.restarted.is(event)) {
      const existing = threads.get(event.payload.newThread.agentId);
      if (
        !existing
        || existing.threadId !== event.payload.previousThreadId
      ) {
        throw new Error(
          `Thread restarted without matching previous thread: ${event.payload.previousThreadId}`,
        );
      }
      threads.set(
        event.payload.newThread.agentId,
        structuredClone(event.payload.newThread),
      );
      continue;
    }
    if (AgentEvents.thread.closed.is(event)) {
      const existing = threads.get(event.payload.agentId);
      if (!existing || existing.threadId !== event.payload.threadId) {
        throw new Error(
          `Thread closed without matching start: ${event.payload.threadId}`,
        );
      }
      threads.set(event.payload.agentId, structuredClone(event.payload));
      continue;
    }
    if (applyTaskJournalEvent(tasks, archivedTasks, event)) {
      if (AgentEvents.task.outcomeSubmitted.is(event)) {
        outcomes.push({
          taskId: event.payload.task.taskId,
          agentId: event.payload.task.agentId,
          stepId: event.payload.stepId,
          outcome: event.payload.outcome,
          journalSeq: event.seq,
          submittedAt: event.payload.submittedAt,
        });
      }
      continue;
    }
    if (AgentEvents.step.started.is(event)
      || AgentEvents.step.completed.is(event)
      || AgentEvents.step.interrupted.is(event)
      || AgentEvents.step.failed.is(event)
      || AgentEvents.step.toolCallReferenced.is(event)
      || AgentEvents.step.humanInputReferenced.is(event)
    ) {
      steps.set(event.payload.stepId, structuredClone(event.payload));
      continue;
    }
    if (AgentEvents.toolCall.observed.is(event)) {
      const existing = toolCalls.get(event.payload.toolCallId);
      if (existing && (
        existing.agentId !== event.payload.agentId
        || existing.stepId !== event.payload.stepId
        || existing.itemId !== event.payload.itemId
      )) {
        throw new Error(`Tool call ${event.payload.toolCallId} conflicts during projection.`);
      }
      if (existing && event.payload.sourceSeq < existing.sourceSeq) continue;
      toolCalls.set(event.payload.toolCallId, structuredClone(event.payload));
      continue;
    }
    if (AgentEvents.step.planUpdated.is(event)) {
      const current = steps.get(event.payload.stepId);
      if (!current) {
        throw new Error(`Agent step plan update has no step: ${event.payload.stepId}`);
      }
      if (
        current.agentId !== event.payload.agentId
        || current.taskId !== event.payload.taskId
      ) {
        throw new Error(`Agent step plan update conflicts with step owner: ${event.payload.stepId}`);
      }
      steps.set(event.payload.stepId, {
        ...current,
        turnId: event.payload.turnId,
        plan: structuredClone(event.payload.plan),
        updatedAt: event.payload.updatedAt,
      });
      continue;
    }
    if (SystemEvents.interaction.userMessageSubmitted.is(event)) {
      userMessages.push({
        messageId: event.payload.messageId,
        text: event.payload.text,
        attachment: event.payload.attachment,
        acceptedAt: event.payload.submittedAt,
        seq: event.seq,
      });
      continue;
    }
    if (AgentEvents.coordinator.messageProduced.is(event)) {
      coordinatorMessages.push({
        messageId: event.payload.messageId,
        text: event.payload.text,
        createdAt: event.payload.createdAt,
        seq: event.seq,
      });
      continue;
    }
    if (AgentEvents.message.queued.is(event)) {
      const existing = queuedMessages.get(event.payload.messageId);
      if (existing && (
        existing.agentId !== event.payload.agentId
        || existing.taskId !== event.payload.taskId
        || existing.body !== event.payload.body
        || existing.queuedAt !== event.payload.queuedAt
        || existing.deliveryMode !== event.payload.deliveryMode
      )) {
        throw new Error(`Message ${event.payload.messageId} has conflicting queued deliveries.`);
      }
      if (!existing) {
        queuedMessages.set(event.payload.messageId, structuredClone(event.payload));
        queuedMessageSeq.set(event.payload.messageId, event.seq);
      }
      if (event.payload.taskId) {
        const task = tasks.get(event.payload.taskId);
        if (task) {
          tasks.set(task.taskId, {
            ...task,
            updatedAt: event.payload.queuedAt,
          });
        }
      }
      continue;
    }
    if (AgentEvents.message.consumed.is(event)) {
      for (const request of humanRequests.values()) {
        if (request.message.messageId === event.payload.messageId) {
          if (request.requestConsumption) {
            throw new Error(`Human input request ${request.requestId} was consumed more than once.`);
          }
          humanRequests.set(request.requestId, {
            ...request,
            requestConsumption: structuredClone(event.payload),
          });
          break;
        }
        if (request.response?.message.messageId === event.payload.messageId) {
          if (request.response.consumption) {
            throw new Error(`Human input response ${request.requestId} was consumed more than once.`);
          }
          humanRequests.set(request.requestId, {
            ...request,
            response: {
              ...request.response,
              consumption: structuredClone(event.payload),
            },
          });
          break;
        }
      }
      consumedMessages.add(event.payload.messageId);
      continue;
    }
    if (AgentEvents.turn.started.is(event)) {
      turns.set(event.payload.invocationId, {
        invocationId: event.payload.invocationId,
        agentId: event.payload.agentId,
        role: event.payload.role,
        taskId: event.payload.taskId,
        threadId: event.payload.threadId,
        prompt: event.payload.prompt,
        startedSeq: event.seq,
        startedAt: event.payload.startedAt,
      });
      continue;
    }
    if (AgentEvents.turn.completed.is(event)) {
      const existing = turns.get(event.payload.turn.invocationId);
      if (!existing) {
        throw new Error(`Turn completed without start: ${event.payload.turn.invocationId}`);
      }
      turns.set(existing.invocationId, {
        ...existing,
        completedSeq: event.seq,
        completedAt: event.payload.turn.finishedAt,
        status: event.payload.turn.status,
        error: event.payload.turn.error,
      });
      continue;
    }
    if (AgentEvents.turn.interrupted.is(event)) {
      const existing = turns.get(event.payload.invocationId);
      if (!existing) {
        throw new Error(`Turn interrupted without start: ${event.payload.invocationId}`);
      }
      turns.set(existing.invocationId, {
        ...existing,
        completedSeq: event.seq,
        completedAt: event.payload.interruptedAt,
        status: "interrupted",
        error: event.payload.reason,
      });
      continue;
    }
    if (AgentEvents.humanInput.requested.is(event)) {
      humanRequests.set(event.payload.requestId, structuredClone(event.payload));
      recoveryMessages.set(
        event.payload.message.messageId,
        structuredClone(event.payload.message),
      );
      recoveryMessageSeq.set(event.payload.message.messageId, event.seq);
      recoveryMessageTask.set(event.payload.message.messageId, event.payload.taskId);
      continue;
    }
    if (AgentEvents.humanInput.responded.is(event)) {
      const request = humanRequests.get(event.payload.requestId);
      if (!request) {
        throw new Error(`Human input response has no request: ${event.payload.requestId}`);
      }
      humanRequests.set(request.requestId, {
        ...request,
        response: {
          stepId: event.payload.stepId,
          body: event.payload.body,
          respondedAt: event.payload.respondedAt,
          message: structuredClone(event.payload.message),
        },
      });
      recoveryMessages.set(
        event.payload.message.messageId,
        structuredClone(event.payload.message),
      );
      recoveryMessageSeq.set(event.payload.message.messageId, event.seq);
      recoveryMessageTask.set(event.payload.message.messageId, event.payload.taskId);
      continue;
    }
    const domainFact = domainJournal?.project(event, event.seq);
    if (domainFact?.kind === "artifact") {
      artifacts.push({
        ...structuredClone(domainFact.payload),
        journalSeq: event.seq,
      });
    } else if (domainFact?.kind === "gate") {
      gates.push({
        ...structuredClone(domainFact.payload),
        journalSeq: event.seq,
      });
    }
  }

  const recoverableMessages = new Map(recoveryMessages);
  const recoverableMessageSeq = new Map(recoveryMessageSeq);
  for (const [messageId, message] of queuedMessages) {
    recoverableMessages.set(messageId, message);
    recoverableMessageSeq.set(
      messageId,
      queuedMessageSeq.get(messageId) ?? Number.MAX_SAFE_INTEGER,
    );
  }
  const obsoleteHumanRequestMessages = new Set(
    [...humanRequests.values()]
      .filter((request) => {
        const task = tasks.get(request.taskId);
        return request.response !== undefined
          || task?.status === AgentTaskStatuses.Done
          || task?.status === AgentTaskStatuses.Failed
          || task?.status === AgentTaskStatuses.Stopped;
      })
      .map((request) => request.message.messageId),
  );

  return {
    runId: created.payload.runId,
    checkpointSeq: events[events.length - 1]?.seq ?? 0,
    threads: [...threads.values()].map((thread) => structuredClone(thread)),
    tasks: [...tasks.values()].map((task) => structuredClone(task)),
    archivedTasks: [...archivedTasks.values()].map((task) => structuredClone(task)),
    messageDeliveries: [...queuedMessages.values()].map((message) => structuredClone(message)),
    pendingMessages: [
      ...userMessages
        .filter((message) =>
          !queuedMessages.has(message.messageId)
          && !consumedMessages.has(message.messageId)
        )
        .map((message) => ({
          seq: message.seq,
          message: {
            messageId: message.messageId,
            agentId: synthesisRole,
            body: message.attachment,
            queuedAt: message.acceptedAt,
          },
        })),
      ...[...recoverableMessages.values()]
        .filter((message) => {
          if (consumedMessages.has(message.messageId)) return false;
          if (obsoleteHumanRequestMessages.has(message.messageId)) return false;
          const taskId = message.taskId ?? recoveryMessageTask.get(message.messageId);
          return !taskId || !archivedTasks.has(taskId);
        })
        .map((message) => ({
          seq: recoverableMessageSeq.get(message.messageId) ?? Number.MAX_SAFE_INTEGER,
          message,
        })),
    ]
      .sort((left, right) => left.seq - right.seq)
      .map(({ message }) => structuredClone(message)),
    humanInputRequests: [...humanRequests.values()].map((request) => structuredClone(request)),
    turns: [...turns.values()].map((turn) => structuredClone(turn)),
    steps: [...steps.values()].map((step) => structuredClone(step)),
    toolCalls: [...toolCalls.values()].map((call) => structuredClone(call)),
    taskOutcomes: outcomes,
    artifacts,
    gates,
    userMessages,
    coordinatorMessages,
  };
}

/** Resolves one task's ordered step references from the projected Step authority. */
export function projectedStepsForTask(
  projection: Pick<RunProjection, "steps">,
  task: AgentTaskState,
): AgentStepState[] {
  return task.stepIds.map((stepId) => {
    const step = projection.steps.find((candidate) => candidate.stepId === stepId);
    if (!step) throw new Error(`Task ${task.taskId} references unknown Agent step ${stepId}.`);
    if (step.taskId !== task.taskId || step.agentId !== task.agentId) {
      throw new Error(`Agent step ${stepId} does not belong to task ${task.taskId}.`);
    }
    return structuredClone(step);
  });
}

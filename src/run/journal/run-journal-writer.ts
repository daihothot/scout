import { AgentEvents } from "../../agent/events/index.js";
import type {
  EventType,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { EventSubscriptionPriorities } from "../../core/events/index.js";
import { ValidationEvents } from "../../domain/validation/validation-events.js";
import { SystemEvents } from "../../system/events/index.js";
import { RunEvents } from "../events/index.js";
import { currentRunScope } from "../run-scope.js";

const persistedEventTypes: EventType[] = [
  RunEvents.run.created,
  RunEvents.runtime.attached,
  RunEvents.runtime.ready,
  RunEvents.runtime.detached,
  RunEvents.runtime.interrupted,
  SystemEvents.interaction.userMessageSubmitted,
  AgentEvents.coordinator.messageProduced,
  AgentEvents.thread.started,
  AgentEvents.thread.resumed,
  AgentEvents.thread.restarted,
  AgentEvents.thread.closed,
  AgentEvents.message.queued,
  AgentEvents.message.consumed,
  AgentEvents.turn.started,
  AgentEvents.turn.completed,
  AgentEvents.turn.interrupted,
  AgentEvents.task.assigned,
  AgentEvents.task.stepStarted,
  AgentEvents.task.stepCompleted,
  AgentEvents.task.stepInterrupted,
  AgentEvents.task.dispositionRecorded,
  AgentEvents.task.outcomeSubmitted,
  AgentEvents.task.done,
  AgentEvents.task.archived,
  AgentEvents.task.failed,
  AgentEvents.task.stopped,
  AgentEvents.step.started,
  AgentEvents.step.completed,
  AgentEvents.step.interrupted,
  AgentEvents.step.failed,
  AgentEvents.step.planUpdated,
  AgentEvents.step.toolCallReferenced,
  AgentEvents.step.humanInputReferenced,
  AgentEvents.toolCall.observed,
  AgentEvents.humanInput.requested,
  AgentEvents.humanInput.responded,
  ValidationEvents.artifact.published,
  ValidationEvents.gate.recorded,
];

/**
 * Subscribes to the event facts that form run history and appends them to the
 * active journal. It reports persistent write failure once and owns no event
 * production or recovery policy.
 */
export class RunJournalWriter {
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private failurePublished = false;

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const scope = currentRunScope();
    for (const type of persistedEventTypes) {
      this.unsubscribers.push(
        scope.eventBus.subscribe(type, (event) => {
          let failure: unknown;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              scope.journal.append(event);
              this.failurePublished = false;
              return;
            } catch (error) {
              failure = error;
            }
          }
          if (!this.failurePublished) {
            this.failurePublished = true;
            const failedAt = new Date().toISOString();
            const payload = {
              failedEventId: event.id,
              failedEventKey: event.key.routeKey,
              error: failure instanceof Error
                ? failure.stack ?? failure.message
                : String(failure),
              failedAt,
            };
            scope.eventBus.publish(RunEvents.journal.writeFailed, payload, {
              occurredAt: failedAt,
            });
            try {
              scope.logger.warn({
                module: "run.journal",
                event: "run_journal_write_failed",
                message: `Failed to append ${payload.failedEventKey} to the run journal after 2 attempts.`,
                data: payload,
              });
            } catch {
              // The runtime logger may share the same unavailable filesystem.
            }
          }
        }, {
          priority: EventSubscriptionPriorities.High,
        }),
      );
    }
  }

  stop(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }
}

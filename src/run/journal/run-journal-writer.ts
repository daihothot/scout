import { AgentEvents } from "../../agent/events/index.js";
import type {
  EventType,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { EventSubscriptionPriorities } from "../../core/events/index.js";
import { WorkflowEvents } from "../../core/workflow/index.js";
import { SystemEvents } from "../../system/events/index.js";
import { RunEvents } from "../events/index.js";
import { currentRunScope } from "../run-scope.js";

const persistedEventTypes: EventType[] = [
  RunEvents.run.created,
  WorkflowEvents.workflow.initialized,
  WorkflowEvents.workflow.advanced,
  RunEvents.runtime.attached,
  RunEvents.runtime.detached,
  RunEvents.runtime.interrupted,
  SystemEvents.interaction.userMessageSubmitted,
  AgentEvents.coordinator.messageProduced,
  AgentEvents.thread.started,
  AgentEvents.thread.restarted,
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
];

/**
 * Appends shared and Domain recovery facts to their active journals. It
 * reports persistent write failure once and owns no event production or
 * recovery-window policy.
 */
export class RunJournalWriter {
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private failurePublished = false;

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const scope = currentRunScope();
    const domainEventTypes = scope.domain.journal?.eventTypes ?? [];
    if (scope.domainJournal === scope.journal) {
      this.subscribeJournal(
        scope,
        [...persistedEventTypes, ...domainEventTypes],
        scope.journal,
        "run",
      );
      return;
    }
    this.subscribeJournal(scope, persistedEventTypes, scope.journal, "run");
    this.subscribeJournal(
      scope,
      domainEventTypes,
      scope.domainJournal,
      "domain",
    );
  }

  stop(): void {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }

  private subscribeJournal(
    scope: ReturnType<typeof currentRunScope>,
    eventTypes: readonly EventType[],
    journal: ReturnType<typeof currentRunScope>["journal"],
    journalName: string,
  ): void {
    const uniqueEventTypes = [...new Map(eventTypes.map((type) => [type.routeKey, type])).values()];
    for (const type of uniqueEventTypes) {
      this.unsubscribers.push(
        scope.eventBus.subscribe(type, (event) => {
          let failure: unknown;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              journal.append(event);
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
              journal: journalName,
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
                message: `Failed to append ${payload.failedEventKey} to the ${journalName} journal after 2 attempts.`,
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
}

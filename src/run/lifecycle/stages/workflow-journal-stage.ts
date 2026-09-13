import type { ScoutEvent, UnsubscribeEventHandler } from "../../../core/events/index.js";
import { EventSubscriptionPriorities } from "../../../core/events/index.js";
import { resolveSynthesisRole, WorkflowEvents } from "../../../core/workflow/index.js";
import { AgentEvents } from "../../../agent/events/index.js";
import { AgentStepStatuses } from "../../../agent/step/types.js";
import { SystemEvents } from "../../../system/events/index.js";
import { RunEvents } from "../../events/index.js";
import type { RunJournalEvent } from "../../journal/index.js";
import { projectRun } from "../../resume/projection/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Replaces a completed Workflow's recovery window before its next execution starts. */
export class WorkflowJournalStage implements RunStage {
  readonly id = "workflow_journal";
  private unsubscribe?: UnsubscribeEventHandler;

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(
      SystemEvents.interaction.userMessageSubmitted,
      () => this.beginNextWorkflowIfCompleted(),
      { priority: EventSubscriptionPriorities.Critical },
    );
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private beginNextWorkflowIfCompleted(): void {
    const scope = currentRunScope();
    const previousEvents = scope.journal.readAll();
    const latestWorkflowEvent = [...previousEvents].reverse().find((event) =>
      WorkflowEvents.workflow.initialized.is(event)
      || WorkflowEvents.workflow.advanced.is(event)
    );
    if (
      !latestWorkflowEvent
      || !WorkflowEvents.workflow.advanced.is(latestWorkflowEvent)
      || !latestWorkflowEvent.payload.cycleCompleted
    ) return;

    const projection = projectRun(
      previousEvents,
      resolveSynthesisRole(scope.scheduler.snapshot()).name,
      scope.domain.journal,
      scope.domainJournal.readAll(),
    );
    const blockingReasons = [
      ...(projection.tasks.length === 0
        ? []
        : [`${projection.tasks.length} unarchived Task(s)`]),
      ...(projection.pendingMessages.length === 0
        ? []
        : [`${projection.pendingMessages.length} pending Agent message(s)`]),
      ...(projection.turns.some((turn) => turn.completedAt === undefined)
        ? ["an unfinished Agent turn"]
        : []),
      ...(projection.steps.some((step) => step.status === AgentStepStatuses.Running)
        ? ["a running Agent step"]
        : []),
      ...scope.agentRegistry.listAgents().flatMap((agent) => {
        const snapshot = agent.snapshot();
        if (snapshot.activeTask) return [`Agent ${agent.agentId} still owns a Task`];
        if (snapshot.pendingMessageCount > 0) {
          return [`Agent ${agent.agentId} still has pending messages`];
        }
        return [];
      }),
    ];
    if (blockingReasons.length > 0) {
      throw new Error(
        `Cannot begin the next Workflow execution: ${blockingReasons.join(", ")}.`,
      );
    }

    const runCreated = previousEvents.find((event) => RunEvents.run.created.is(event));
    const workflowInitialized = previousEvents.find((event) =>
      WorkflowEvents.workflow.initialized.is(event)
    );
    const runtimeAttached = [...previousEvents].reverse().find((event) =>
      RunEvents.runtime.attached.is(event)
    );
    if (!runCreated || !workflowInitialized || !runtimeAttached) {
      throw new Error("Cannot begin the next Workflow execution without its Run baseline.");
    }
    const baselineAt = new Date().toISOString();
    const threadEvents: ScoutEvent[] = scope.agentRegistry.listAgents().map((agent, index) => {
      const thread = agent.threadSnapshot;
      if (!thread || thread.status !== "active") {
        throw new Error(`Cannot begin the next Workflow execution without active Agent ${agent.agentId}.`);
      }
      return {
        id: `workflow-baseline-thread-${index + 1}-${baselineAt}`,
        key: AgentEvents.thread.started,
        payload: structuredClone(thread),
        occurredAt: baselineAt,
      };
    });
    const nextBaseline: ScoutEvent[] = [
      toScoutEvent(runCreated),
      toScoutEvent(workflowInitialized),
      toScoutEvent(runtimeAttached),
      ...threadEvents,
    ];
    const previousDomainEvents = scope.domainJournal === scope.journal
      ? []
      : scope.domainJournal.readAll();
    const previousManifest = scope.manifestStore.read();
    try {
      scope.journal.replaceAll(nextBaseline);
      if (scope.domainJournal !== scope.journal) scope.domainJournal.replaceAll([]);
      scope.manifestStore.update((manifest) => ({
        ...manifest,
        checkpointSeq: scope.journal.lastSeq,
      }));
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        scope.journal.replaceAll(previousEvents);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (scope.domainJournal !== scope.journal) {
        try {
          scope.domainJournal.replaceAll(previousDomainEvents);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      try {
        scope.manifestStore.restore(previousManifest);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Workflow Journal replacement and rollback both failed.",
        );
      }
      throw error;
    }

    scope.stepStore.restore([]);
    scope.toolCallStore.restore([]);
    scope.humanInputStore.restore([]);
  }
}

function toScoutEvent(event: RunJournalEvent): ScoutEvent {
  return {
    id: event.id,
    key: event.key,
    payload: structuredClone(event.payload),
    occurredAt: event.occurredAt,
  };
}

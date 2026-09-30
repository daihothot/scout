import { WorkflowEvents } from "../../../core/workflow/workflow-events.js";
import type { WorkflowState } from "../../../core/workflow/workflow-state.js";
import { EventSubscriptionPriorities } from "../../../core/events/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import {
  ScoutDomainId,
  type ScoutDomain,
  type ScoutDomainDescription,
} from "../../types.js";
import type { DomainAgentToolRegistration } from "../../agent/index.js";
import { BaseDomainAgentBackend } from "./agent/index.js";
import {
  ExecutionPlatformTool,
  executionPlatformAgentTool,
} from "./agent/tools/index.js";
import { BaseDomainRecordObject, type BaseDomainRuntimeFact } from "./base-domain-record-object.js";
import { BaseDomainToolCallStore } from "./base-domain-tool-call-store.js";
import { BaseDomainExecution } from "./execution/index.js";

/** Complete shared Domain runtime for one active Workflow. */
export class BaseDomain implements ScoutDomain {
  readonly description: ScoutDomainDescription = Object.freeze({
    id: ScoutDomainId.Base,
    name: "Scout Base Domain",
  });
  readonly recordObject = new BaseDomainRecordObject();
  readonly toolCallStore = new BaseDomainToolCallStore();
  readonly execution: BaseDomainExecution;
  readonly backend: BaseDomainAgentBackend;
  readonly agentTools: Readonly<{
    executionPlatform: DomainAgentToolRegistration;
  }>;
  private restoredFact: BaseDomainRuntimeFact = {
    domainId: "base",
    journalSeq: 0,
    toolCalls: [],
  };
  private started = false;
  private unsubscribeWorkflowCommit?: () => void;

  constructor() {
    const scope = currentRunScope();
    this.execution = new BaseDomainExecution(scope.eventBus, scope.executionSystem);
    this.backend = new BaseDomainAgentBackend(this.toolCallStore);
    this.agentTools = Object.freeze({
      executionPlatform: Object.freeze({
        definition: executionPlatformAgentTool,
        tool: new ExecutionPlatformTool(this.execution),
      }),
    });
  }

  get runtimeFact(): BaseDomainRuntimeFact {
    return structuredClone(this.restoredFact);
  }

  start(): void {
    if (this.started) return;
    const scope = currentRunScope();
    const workflowState = scope.workflow.snapshot();
    this.recordObject.start();
    this.unsubscribeWorkflowCommit = scope.eventBus.subscribe(WorkflowEvents.workflow.committing, () => {
      this.restoredFact = { domainId: "base", journalSeq: 0, toolCalls: [] };
      this.toolCallStore.clear();
      this.execution.stop();
    }, { priority: EventSubscriptionPriorities.Normal });
    this.started = true;
    scope.logger.info({
      module: "domain.base",
      event: "base_domain_started",
      message: "Started Base Domain.",
      data: { workflowId: workflowState?.workflowId },
    });
  }

  stop(): void {
    const wasStarted = this.started;
    this.started = false;
    const failures: unknown[] = [];
    for (const release of [
      () => { this.unsubscribeWorkflowCommit?.(); this.unsubscribeWorkflowCommit = undefined; },
      () => this.recordObject.stop(),
      () => this.execution.stop(),
      () => this.toolCallStore.clear(),
      () => this.recordObject.close(),
    ]) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (wasStarted) {
      try {
        currentRunScope().logger.info({
          module: "domain.base",
          event: "base_domain_stopped",
          message: "Stopped Base Domain.",
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Failed to stop Base Domain.");
  }

  finishWorkflow(): void {
    this.recordObject.releaseWorkflow();
  }

  restore(workflowState: WorkflowState): void {
    if (workflowState.status === "completed") {
      this.restoredFact = {
        domainId: "base",
        journalSeq: 0,
        toolCalls: [],
      };
      this.toolCallStore.clear();
      this.execution.stop();
      return;
    }
    this.restoredFact = this.recordObject.aggregate(this.recordObject.readAll());
    this.toolCallStore.restore(this.restoredFact.toolCalls);
    this.execution.restore(this.restoredFact);
  }

  close(): void {
    this.stop();
  }
}

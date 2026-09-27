import type { WorkflowFlowState } from "../../../core/workflow/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import {
  ScoutDomainId,
  type ScoutDomain,
  type ScoutDomainDescription,
  type ScoutDomainFlowChange,
} from "../../types.js";
import type { DomainAgentToolRegistration } from "../../agent/index.js";
import { BaseDomainAgentBackend } from "./agent/index.js";
import {
  ExecutionPlatformTool,
  executionPlatformAgentTool,
} from "./agent/tools/index.js";
import { BaseDomainJournal, type BaseDomainRuntimeFact } from "./base-domain-journal.js";
import { BaseDomainToolCallStore } from "./base-domain-tool-call-store.js";
import { BaseDomainExecution } from "./execution/index.js";

/** Complete shared Domain runtime for one active Workflow Flow. */
export class BaseDomain implements ScoutDomain {
  readonly description: ScoutDomainDescription = Object.freeze({
    id: ScoutDomainId.Base,
    name: "Scout Base Domain",
  });
  readonly journal = new BaseDomainJournal();
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
    const flow = scope.workflow.flowSnapshot();
    this.journal.start();
    this.started = true;
    scope.logger.info({
      module: "domain.base",
      event: "base_domain_started",
      message: `Started Base Domain for Workflow Flow ${flow.flowId}.`,
      data: { flowId: flow.flowId },
    });
  }

  stop(): void {
    const wasStarted = this.started;
    this.started = false;
    const failures: unknown[] = [];
    for (const release of [
      () => this.journal.stop(),
      () => this.execution.stop(),
      () => this.toolCallStore.clear(),
      () => this.journal.close(),
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

  restore(flow: WorkflowFlowState): void {
    if (flow.status === "completed") {
      this.restoredFact = {
        domainId: "base",
        journalSeq: 0,
        toolCalls: [],
      };
      this.toolCallStore.clear();
      this.execution.stop();
      return;
    }
    this.restoredFact = this.journal.aggregate(this.journal.readAll());
    this.toolCallStore.restore(this.restoredFact.toolCalls);
    this.execution.restore(this.restoredFact);
  }

  prepareFlow(_flow: WorkflowFlowState, journalRoot: string): ScoutDomainFlowChange {
    const journalChange = this.journal.prepareFlow(journalRoot);
    return {
      commit: () => {
        journalChange.commit();
        this.restoredFact = {
          domainId: "base",
          journalSeq: 0,
          toolCalls: [],
        };
        this.toolCallStore.clear();
        this.execution.stop();
      },
      abort: () => journalChange.abort(),
      releasePrevious: () => journalChange.releasePrevious(),
    };
  }

  close(): void {
    this.stop();
  }
}

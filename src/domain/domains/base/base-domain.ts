import type { WorkflowData } from "../../../core/workflow/workflow-data.js";
import { currentRunScope } from "../../../run/run-scope.js";
import {
  ScoutDomainId,
  type ScoutDomain,
  type ScoutDomainDescription,
} from "../../types.js";
import { BaseDomainAgentBackend } from "./agent/index.js";
import { BaseDomainRecordObject } from "./record/base-domain-record-object.js";
import { BaseDomainProjector, type BaseDomainRuntimeFact } from "./projector/base-domain-projector.js";
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
  private restoredFact: BaseDomainRuntimeFact = {
    domainId: "base",
    journalSeq: 0,
    toolCalls: [],
  };
  private started = false;

  constructor() {
    const scope = currentRunScope();
    this.execution = new BaseDomainExecution(scope.eventBus, scope.executionSystem);
    this.backend = new BaseDomainAgentBackend();
  }

  get runtimeFact(): BaseDomainRuntimeFact {
    return structuredClone(this.restoredFact);
  }

  start(): void {
    if (this.started) return;
    const scope = currentRunScope();
    const workflowData = scope.workflow.snapshot();
    this.recordObject.start();
    this.toolCallStore.start();
    this.started = true;
    scope.logger.info({
      module: "domain.base",
      event: "base_domain_started",
      message: "Started Base Domain.",
      data: { workflowId: workflowData?.workflowId },
    });
  }

  stop(): void {
    const wasStarted = this.started;
    this.started = false;
    const failures: unknown[] = [];
    for (const release of [
      () => this.recordObject.stop(),
      () => this.execution.stop(),
      () => this.toolCallStore.stop(),
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

  create(): void {
    this.restoredFact = { domainId: "base", journalSeq: 0, toolCalls: [] };
    this.toolCallStore.clear();
    this.execution.stop();
  }

  restore(_workflowData: WorkflowData): void {
    if (_workflowData.status === "completed") return;
    this.recordObject.attach(currentRunScope().workflow.journalRoot);
    const records = this.recordObject.read();
    const runtimeObject = new BaseDomainProjector().project(records);
    this.restoredFact = runtimeObject;
    this.toolCallStore.restore(this.restoredFact.toolCalls);
    this.execution.restore(this.restoredFact);
  }

  run(): void {}
  async close(): Promise<void> { await this.execution.drain(); }
  async abort(): Promise<void> { await this.execution.drain(); }

  clearWorkflow(): void {
    this.restoredFact = { domainId: "base", journalSeq: 0, toolCalls: [] };
    this.toolCallStore.clear();
    this.execution.stop();
    this.recordObject.release();
  }
}

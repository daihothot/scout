import {
  AgentBackendStage, AgentTelemetryStage, DomainStage, ExecutionStage,
  InteractionStage, OrchestratorStage, RunRuntimeStage, RunScopeStage,
  RequestHubStage, WorkflowStage, RunStageExecutor, type RunStage,
} from "../lifecycle/index.js";
import type { Workflow, WorkflowResumeInput } from "../../core/workflow/index.js";
import type { RunScope } from "../run-scope.js";
import { ResumeClientsStage, RecordResumeInterruptionsStage, RestoreWorkflowStage } from "./stages/index.js";

/** Installs dependencies before the single Workflow recovery driver enters Restoring. */
export class ResumeRunStageAssembly {
  readonly executor: RunStageExecutor;
  readonly runScopeStage: RunScopeStage;
  constructor(input: {
    executor: RunStageExecutor; runScope: RunScope; workflow: Workflow;
    recovery?: WorkflowResumeInput; missingWorkflowId?: string;
    clientsStage: ResumeClientsStage; environmentStage: RunStage;
  }) {
    const executor = input.executor;
    const runScopeStage = new RunScopeStage(input.runScope);
    executor.registerSerial(
      runScopeStage, new WorkflowStage(input.workflow), new RequestHubStage(),
      input.clientsStage, input.environmentStage, new ExecutionStage(), new InteractionStage(),
      new DomainStage(), new AgentTelemetryStage(),
    );
    executor.registerSerial(new OrchestratorStage(), new AgentBackendStage());
    executor.registerSerial(
      new RestoreWorkflowStage(input.recovery, input.missingWorkflowId),
      new RecordResumeInterruptionsStage(), new RunRuntimeStage("resume"),
    );
    this.executor = executor;
    this.runScopeStage = runScopeStage;
  }
}

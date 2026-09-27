import {
  AgentBackendStage,
  AgentTelemetryStage,
  DomainStage,
  ExecutionStage,
  InteractionStage,
  OrchestratorStage,
  RunRuntimeStage,
  RunScopeStage,
  RunStageExecutor,
  WorkflowStage,
  type RunStage,
} from "../lifecycle/index.js";
import type { Workflow } from "../../core/workflow/index.js";
import type { RunScope } from "../run-scope.js";
import {
  ResumeClientsStage,
  RestoreAgentsStage,
  RestoreDomainStage,
  RestoreTasksStage,
  InjectResumeContextStage,
  RecordResumeInterruptionsStage,
} from "./stages/index.js";

/**
 * Defines the resume lifecycle graph and its ordering constraints.
 *
 * Serial groups protect dependencies such as scope, environment, and task
 * restoration; independent domain/backend services are registered in parallel.
 * The assembly owns registration only, while each stage owns its resources and
 * restoration policy.
 */
export class ResumeRunStageAssembly {
  readonly executor: RunStageExecutor;
  readonly runScopeStage: RunScopeStage;
  readonly injectResumeContextStage: InjectResumeContextStage;

  /** Registers the complete resume graph and retains the post-start activation stage. */
  constructor(input: {
    executor: RunStageExecutor;
    runScope: RunScope;
    workflow: Workflow;
    clientsStage: ResumeClientsStage;
    environmentStage: RunStage;
  }) {
    const executor = input.executor;
    const runScopeStage = new RunScopeStage(input.runScope);

    executor.registerSerial(
      runScopeStage,
      new WorkflowStage(input.workflow),
      input.clientsStage,
      input.environmentStage,
      new ExecutionStage(),
      new InteractionStage(),
      new DomainStage(),
      new RestoreDomainStage(),
      new RecordResumeInterruptionsStage(),
      new RunRuntimeStage("resume"),
    );
    executor.registerSerial(new AgentTelemetryStage());
    executor.registerParallel(new AgentBackendStage(), new OrchestratorStage());
    executor.registerSerial(new RestoreAgentsStage());
    const injectResumeContextStage = new InjectResumeContextStage();
    executor.registerSerial(
      new RestoreTasksStage(),
      injectResumeContextStage,
    );

    this.executor = executor;
    this.runScopeStage = runScopeStage;
    this.injectResumeContextStage = injectResumeContextStage;
  }
}

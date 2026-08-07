import {
  AgentBackendStage,
  AgentTelemetryStage,
  DomainStage,
  InteractionStage,
  OrchestratorStage,
  RunJournalWriterStage,
  RunRuntimeStage,
  RunScopeStage,
  RunStageExecutor,
} from "../lifecycle/index.js";
import type { RunScope } from "../run-scope.js";
import {
  ResumeClientsStage,
  RestoreAgentsStage,
  RestoreDomainStage,
  RestoreEnvironmentStage,
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
  }) {
    const executor = input.executor;
    const runScopeStage = new RunScopeStage(input.runScope);

    executor.registerSerial(
      runScopeStage,
      new RunJournalWriterStage(),
      new ResumeClientsStage(),
      new RestoreEnvironmentStage(),
      new RecordResumeInterruptionsStage(),
      new RunRuntimeStage("resume"),
      new InteractionStage(),
    );
    executor.registerParallel(new DomainStage(), new AgentTelemetryStage());
    executor.registerSerial(new RestoreDomainStage());
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

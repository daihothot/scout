import {
  AgentBackendStage,
  AgentTelemetryStage,
  AgentsStage,
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
  RestoreDomainStage,
  RestoreEnvironmentStage,
  RestoreTasksStage,
  InjectResumeContextStage,
  RecordResumeInterruptionsStage,
} from "./stages/index.js";

export class ResumeRunStageAssembly {
  readonly executor: RunStageExecutor;
  readonly runScopeStage: RunScopeStage;
  readonly injectResumeContextStage: InjectResumeContextStage;

  constructor(input: {
    executor: RunStageExecutor;
    runScope: RunScope;
  }) {
    const executor = input.executor;
    const runScopeStage = new RunScopeStage(input.runScope);

    executor.registerSerial(
      runScopeStage,
      new RunJournalWriterStage(),
      new RecordResumeInterruptionsStage(),
      new RunRuntimeStage("resume"),
      new RestoreEnvironmentStage(),
      new ResumeClientsStage(),
      new InteractionStage(),
    );
    executor.registerParallel(new DomainStage(), new AgentTelemetryStage());
    executor.registerSerial(new RestoreDomainStage());
    executor.registerParallel(new AgentBackendStage(), new OrchestratorStage());
    executor.registerSerial(new AgentsStage());
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

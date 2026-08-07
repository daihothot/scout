import {
  AgentBackendStage,
  AgentTelemetryStage,
  AgentsStage,
  DomainStage,
  InteractionStage,
  OrchestratorStage,
  RunAppServerStage,
  RunJournalWriterStage,
  RunRuntimeStage,
  RunScopeStage,
  RunStageExecutor,
} from "../lifecycle/index.js";
import type { RunScope } from "../run-scope.js";
import { PrepareEnvironmentStage } from "./stages/prepare-environment-stage.js";
import { InitializeRunStage } from "./stages/initialize-run-stage.js";

/** Registers startup's lifecycle groups and exposes its scope stage. */
export class StartRunStageAssembly {
  readonly executor: RunStageExecutor;
  readonly runScopeStage: RunScopeStage;

  constructor(input: {
    executor: RunStageExecutor;
    runScope: RunScope;
  }) {
    const executor = input.executor;
    const runScopeStage = new RunScopeStage(input.runScope);

    executor.registerSerial(
      runScopeStage,
      new RunJournalWriterStage(),
      new InitializeRunStage(),
      new RunRuntimeStage("start"),
      new InteractionStage(),
      new RunAppServerStage(),
      new PrepareEnvironmentStage(),
    );
    executor.registerParallel(new DomainStage(), new AgentTelemetryStage());
    executor.registerParallel(new AgentBackendStage(), new OrchestratorStage());
    executor.registerSerial(new AgentsStage());

    this.executor = executor;
    this.runScopeStage = runScopeStage;
  }
}

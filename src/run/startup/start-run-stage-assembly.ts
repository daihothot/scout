import {
  AgentBackendStage,
  AgentTelemetryStage,
  AgentsStage,
  DomainStage,
  ExecutionStage,
  InteractionStage,
  OrchestratorStage,
  RunAppServerStage,
  AppServerRootConfigStage,
  RunRuntimeStage,
  RunScopeStage,
  RequestHubStage,
  RunStageExecutor,
} from "../lifecycle/index.js";
import type { Workflow } from "../../core/workflow/index.js";
import type { RunScope } from "../run-scope.js";
import { PrepareEnvironmentStage } from "./stages/prepare-environment-stage.js";
import { InitializeRunStage } from "./stages/initialize-run-stage.js";
import { StartWorkflowStage } from "./stages/start-workflow-stage.js";

/** Registers startup's lifecycle groups and exposes its scope stage. */
export class StartRunStageAssembly {
  readonly executor: RunStageExecutor;
  readonly runScopeStage: RunScopeStage;

  constructor(input: {
    executor: RunStageExecutor;
    runScope: RunScope;
    workflow: Workflow;
  }) {
    const executor = input.executor;
    const runScopeStage = new RunScopeStage(input.runScope);
    const appServerRootConfigStage = new AppServerRootConfigStage();

    executor.registerSerial(
      runScopeStage,
      new InitializeRunStage(),
      new StartWorkflowStage(input.workflow),
      new RequestHubStage(),
      new RunRuntimeStage("start"),
      new ExecutionStage(),
      new InteractionStage(),
      appServerRootConfigStage,
      new RunAppServerStage({ rootConfigStage: appServerRootConfigStage }),
      new PrepareEnvironmentStage(),
    );
    executor.registerParallel(new DomainStage(), new AgentTelemetryStage());
    executor.registerParallel(new AgentBackendStage(), new OrchestratorStage());
    executor.registerSerial(new AgentsStage());

    this.executor = executor;
    this.runScopeStage = runScopeStage;
  }
}

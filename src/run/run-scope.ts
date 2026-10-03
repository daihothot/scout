import type { CodexAppServerClient } from "../agent-server/codex/app-server-client.js";
import type { AssetConfig } from "../asset-store/config/asset-config.js";
import { AgentRegistry } from "../agent/core/agent-registry.js";
import type { AgentOrchestrator } from "../agent/orchestration/agent-orchestrator.js";
import type { EventBus } from "../core/events/index.js";
import type { Logger } from "../core/logging/index.js";
import type { Workflow } from "../core/workflow/workflow.js";
import type { Authorization } from "../core/authorization/authorization.js";
import { DomainRegistry } from "../domain/domain-registry.js";
import type { ExecutionPlatformPort } from "../execution/scout-execution-system.js";
import type { RuntimeInteractionPort } from "../interaction/protocol/port.js";
import {
  defaultScoutConfig,
  type ScoutConfig,
} from "../system/config/index.js";
import type {
  RunContextBundle,
  RunEnvironment,
} from "./types.js";
import type { RunManifestStore } from "./persistence/index.js";

/** Dependencies and lifecycle callbacks required to own one active run. */
export interface RunScopeOptions {
  runId: string;
  scoutRoot: string;
  runRoot: string;
  logger: Logger;
  eventBus: EventBus;
  interactionPort: RuntimeInteractionPort;
  workflow?: Workflow;
  config: AssetConfig;
  scoutConfig?: ScoutConfig;
  manifestStore: RunManifestStore;
  terminate(reason: string): Promise<void>;
}

/**
 * Locates staged domain owners, clients, and the prepared Run environment.
 * It enforces single assignment and run-id consistency but does not create
 * those dependencies or choose stage ordering.
 */
export class RunScope {
  readonly runId: string;
  readonly scoutRoot: string;
  readonly runRoot: string;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly interactionPort: RuntimeInteractionPort;
  readonly agentRegistry = new AgentRegistry();
  readonly domainRegistry = new DomainRegistry();
  readonly config: AssetConfig;
  readonly scoutConfig: ScoutConfig;
  readonly manifestStore: RunManifestStore;
  private readonly terminateRun: RunScopeOptions["terminate"];
  private activeAppServer?: CodexAppServerClient;
  private activeAgentOrchestrator?: AgentOrchestrator;
  private activeExecutionSystem?: ExecutionPlatformPort;
  private activeWorkflow?: Workflow;
  private activeAuthorization?: Authorization;
  private preparedEnvironment?: RunEnvironment;

  constructor(options: RunScopeOptions) {
    this.runId = options.runId;
    this.scoutRoot = options.scoutRoot;
    this.runRoot = options.runRoot;
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.interactionPort = options.interactionPort;
    this.activeWorkflow = options.workflow;
    this.config = options.config;
    this.scoutConfig = options.scoutConfig ?? defaultScoutConfig;
    this.manifestStore = options.manifestStore;
    this.terminateRun = options.terminate;
  }

  get appServer(): CodexAppServerClient {
    if (!this.activeAppServer) {
      throw new Error("Run app-server is not available.");
    }
    return this.activeAppServer;
  }

  get agentOrchestrator(): AgentOrchestrator {
    if (!this.activeAgentOrchestrator) throw new Error("AgentOrchestrator Service is not available.");
    return this.activeAgentOrchestrator;
  }

  setAgentOrchestrator(orchestrator: AgentOrchestrator): void {
    if (this.activeAgentOrchestrator) throw new Error("AgentOrchestrator Service is already available.");
    this.activeAgentOrchestrator = orchestrator;
  }

  clearAgentOrchestrator(orchestrator: AgentOrchestrator): void {
    if (this.activeAgentOrchestrator !== orchestrator) throw new Error("Cannot clear an inactive AgentOrchestrator Service.");
    this.activeAgentOrchestrator = undefined;
  }

  get authorization(): Authorization {
    if (!this.activeAuthorization) throw new Error("Authorization Service is not available.");
    return this.activeAuthorization;
  }

  setAuthorization(authorization: Authorization): void {
    if (this.activeAuthorization) throw new Error("Authorization Service is already available.");
    this.activeAuthorization = authorization;
  }

  clearAuthorization(authorization: Authorization): void {
    if (this.activeAuthorization !== authorization) throw new Error("Cannot clear an inactive Authorization Service.");
    this.activeAuthorization = undefined;
  }

  get executionSystem(): ExecutionPlatformPort {
    if (!this.activeExecutionSystem) {
      throw new Error("Run execution system is not available.");
    }
    return this.activeExecutionSystem;
  }

  get environment(): RunEnvironment {
    if (!this.preparedEnvironment) {
      throw new Error("Run environment is not available.");
    }
    return this.preparedEnvironment;
  }

  get contextBundle(): RunContextBundle {
    return this.environment.contextBundle;
  }

  get workflow(): Workflow {
    if (!this.activeWorkflow) throw new Error("Workflow Service is not available.");
    return this.activeWorkflow;
  }

  get hasEnvironment(): boolean {
    return this.preparedEnvironment !== undefined;
  }

  setWorkflow(workflow: Workflow): void {
    if (this.activeWorkflow) throw new Error("Workflow Service is already available.");
    this.activeWorkflow = workflow;
  }

  clearWorkflow(workflow: Workflow): void {
    if (this.activeWorkflow !== workflow) {
      throw new Error("Cannot clear an inactive Workflow Service.");
    }
    this.activeWorkflow = undefined;
  }

  setAppServer(appServer: CodexAppServerClient): void {
    if (this.activeAppServer) {
      throw new Error("Run app-server is already available.");
    }
    this.activeAppServer = appServer;
  }

  clearAppServer(appServer: CodexAppServerClient): void {
    if (this.activeAppServer !== appServer) {
      throw new Error("Cannot clear an inactive run app-server.");
    }
    this.activeAppServer = undefined;
  }

  setExecutionSystem(executionSystem: ExecutionPlatformPort): void {
    if (this.activeExecutionSystem) {
      throw new Error("Run execution system is already available.");
    }
    this.activeExecutionSystem = executionSystem;
  }

  clearExecutionSystem(executionSystem: ExecutionPlatformPort): void {
    if (this.activeExecutionSystem !== executionSystem) {
      throw new Error("Cannot clear an inactive run execution system.");
    }
    this.activeExecutionSystem = undefined;
  }

  setEnvironment(environment: RunEnvironment): void {
    if (this.preparedEnvironment) {
      throw new Error("Run environment is already available.");
    }
    if (environment.contextBundle.runId !== this.runId) {
      throw new Error(
        `Run environment ${environment.contextBundle.runId} does not belong to ${this.runId}.`,
      );
    }
    this.preparedEnvironment = environment;
  }

  terminate(reason: string): Promise<void> {
    return this.terminateRun(reason);
  }

  /** RunScope disposal boundary; staged owners release their own resources. */
  dispose(): void {}
}

let activeRunScope: RunScope | undefined;

/** Installs the process-local locator; dependent services are installed by their Stages. */
export function installRunScope(scope: RunScope): () => void {
  if (activeRunScope) {
    throw new Error(`Run scope already installed: ${activeRunScope.runId}`);
  }
  activeRunScope = scope;
  return () => {
    if (activeRunScope !== scope) {
      throw new Error(`Cannot release inactive run scope: ${scope.runId}`);
    }
    activeRunScope = undefined;
    scope.dispose();
  };
}

/** Returns the installed scope or fails when no run is active. */
export function currentRunScope(): RunScope {
  if (!activeRunScope) {
    throw new Error("No active Scout run scope.");
  }
  return activeRunScope;
}

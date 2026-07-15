import type { CodexAppServerClient } from "../agent-server/codex/app-server-client.js";
import { AgentRegistry } from "../agent/core/agent-registry.js";
import { AgentTaskStore } from "../agent/task/agent-task-store.js";
import type { EventBus } from "../core/events/index.js";
import type { Logger } from "../core/logging/index.js";
import type { ScoutDomain } from "../domain/index.js";
import type { RuntimeInteractionPort } from "../interaction/protocol/port.js";
import type {
  RunContextBundle,
  RunEnvironment,
} from "./types.js";

export interface RunScopeOptions {
  runId: string;
  repoRoot: string;
  logger: Logger;
  eventBus: EventBus;
  interactionPort: RuntimeInteractionPort;
  domain: ScoutDomain;
  terminate(reason: string): Promise<void>;
}

export class RunScope {
  readonly runId: string;
  readonly repoRoot: string;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly interactionPort: RuntimeInteractionPort;
  readonly agentRegistry = new AgentRegistry();
  readonly taskStore = new AgentTaskStore();
  readonly domain: ScoutDomain;
  private readonly terminateRun: RunScopeOptions["terminate"];
  private activeAppServer?: CodexAppServerClient;
  private preparedEnvironment?: RunEnvironment;

  constructor(options: RunScopeOptions) {
    this.runId = options.runId;
    this.repoRoot = options.repoRoot;
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.interactionPort = options.interactionPort;
    this.domain = options.domain;
    this.terminateRun = options.terminate;
  }

  get appServer(): CodexAppServerClient {
    if (!this.activeAppServer) {
      throw new Error("Run app-server is not available.");
    }
    return this.activeAppServer;
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

  get hasEnvironment(): boolean {
    return this.preparedEnvironment !== undefined;
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
}

let activeRunScope: RunScope | undefined;

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
  };
}

export function currentRunScope(): RunScope {
  if (!activeRunScope) {
    throw new Error("No active Scout run scope.");
  }
  return activeRunScope;
}

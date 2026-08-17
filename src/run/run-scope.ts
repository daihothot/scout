import type { CodexAppServerClient } from "../agent-server/codex/app-server-client.js";
import { AgentRegistry } from "../agent/core/agent-registry.js";
import { AgentHumanInputStore } from "../agent/human-input/index.js";
import { AgentTaskStore } from "../agent/task/agent-task-store.js";
import type { EventBus } from "../core/events/index.js";
import type { Logger } from "../core/logging/index.js";
import type { ScoutDomain } from "../domain/index.js";
import type { RuntimeInteractionPort } from "../interaction/protocol/port.js";
import type {
  RunContextBundle,
  RunEnvironment,
} from "./types.js";
import type { RunJournal } from "./journal/index.js";
import type { RunManifestStore } from "./persistence/index.js";

/** Dependencies and lifecycle callbacks required to own one active run. */
export interface RunScopeOptions {
  runId: string;
  scoutRoot: string;
  runRoot: string;
  logger: Logger;
  eventBus: EventBus;
  interactionPort: RuntimeInteractionPort;
  domain: ScoutDomain;
  journal: RunJournal;
  manifestStore: RunManifestStore;
  terminate(reason: string): Promise<void>;
}

/**
 * Owns the per-run stores, clients, and prepared environment while stages are
 * executing. It enforces single assignment and run-id consistency but does
 * not create those dependencies or choose stage ordering.
 */
export class RunScope {
  readonly runId: string;
  readonly scoutRoot: string;
  readonly runRoot: string;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly interactionPort: RuntimeInteractionPort;
  readonly agentRegistry = new AgentRegistry();
  readonly taskStore = new AgentTaskStore();
  readonly humanInputStore: AgentHumanInputStore;
  readonly domain: ScoutDomain;
  readonly journal: RunJournal;
  readonly manifestStore: RunManifestStore;
  private readonly terminateRun: RunScopeOptions["terminate"];
  private activeAppServer?: CodexAppServerClient;
  private preparedEnvironment?: RunEnvironment;

  constructor(options: RunScopeOptions) {
    this.runId = options.runId;
    this.scoutRoot = options.scoutRoot;
    this.runRoot = options.runRoot;
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.interactionPort = options.interactionPort;
    this.humanInputStore = new AgentHumanInputStore();
    this.domain = options.domain;
    this.journal = options.journal;
    this.manifestStore = options.manifestStore;
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

  dispose(): void {
    this.humanInputStore.dispose();
  }
}

let activeRunScope: RunScope | undefined;

/** Installs the process-local scope and starts its input store. */
export function installRunScope(scope: RunScope): () => void {
  if (activeRunScope) {
    throw new Error(`Run scope already installed: ${activeRunScope.runId}`);
  }
  activeRunScope = scope;
  try {
    scope.humanInputStore.start();
  } catch (error) {
    activeRunScope = undefined;
    throw error;
  }
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

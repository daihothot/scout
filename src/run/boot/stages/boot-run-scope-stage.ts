import type { ScoutDomain } from "../../../domain/index.js";
import type { EventBus } from "../../../core/events/index.js";
import type { Logger } from "../../../core/logging/index.js";
import type { RuntimeInteractionPort } from "../../../interaction/protocol/port.js";
import {
  installRunScope,
  RunScope,
} from "../../run-scope.js";
import type { BootStage } from "../boot-stage.js";

export interface BootRunScopeStageOptions {
  runId: string;
  repoRoot: string;
  logger: Logger;
  eventBus: EventBus;
  interactionPort: RuntimeInteractionPort;
  domain: ScoutDomain;
  terminate(reason: string): Promise<void>;
}

export class BootRunScopeStage implements BootStage {
  readonly id = "run_scope";
  private readonly options: BootRunScopeStageOptions;
  private installedScope?: RunScope;
  private releaseScope?: () => void;

  constructor(options: BootRunScopeStageOptions) {
    this.options = options;
  }

  get scope(): RunScope {
    if (!this.installedScope) throw new Error("Boot run scope stage has not completed.");
    return this.installedScope;
  }

  get scopeCreated(): boolean {
    return this.installedScope !== undefined;
  }

  async start(): Promise<void> {
    const scope = new RunScope({
      runId: this.options.runId,
      repoRoot: this.options.repoRoot,
      logger: this.options.logger,
      eventBus: this.options.eventBus,
      interactionPort: this.options.interactionPort,
      domain: this.options.domain,
      terminate: this.options.terminate,
    });
    this.releaseScope = installRunScope(scope);
    this.installedScope = scope;
  }

  async stop(): Promise<void> {
    const release = this.releaseScope;
    if (!release) return;
    this.releaseScope = undefined;
    release();
  }
}

import type { UnsubscribeEventHandler } from "../../../core/events/index.js";
import {
  ExecutionEvents,
  type ExecutionCommandCompletedEvent,
  type ExecutionPlatformIdentity,
  type ExecutionPlatformRequest,
  type ExecutionSelectionIdentity,
} from "../../../execution/index.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type { RbtRuntimeFact } from "../rbt-journal.js";

export type JarvisBehaviorExecutionTargetResult =
  | {
    ok: true;
    identity: ExecutionPlatformIdentity;
    started: boolean;
  }
  | { ok: false; code: string; message: string };

/** Resolves and keeps the run's physical execution target independently of RBT connection work. */
export class JarvisBehaviorExecutionTargetGate {
  private selection?: ExecutionSelectionIdentity;
  private started = false;
  private sequence = 0;
  private unsubscribe: UnsubscribeEventHandler[] = [];

  async resolve(request: ExecutionPlatformRequest): Promise<JarvisBehaviorExecutionTargetResult> {
    this.observeExecution();
    if (this.selectionMatches(request)) return this.currentTarget();

    const result = await currentRunScope().executionSystem.identify({
      ...(request.transport ? { transport: request.transport } : {}),
      ...(request.platform ? { platform: request.platform } : {}),
    }, {
      correlationId: this.nextCorrelationId("identify"),
    });
    if (!result.ok) return result;
    if (!this.selection || !sameIdentity(this.selection.platform, result.identity)) {
      return {
        ok: false,
        code: "execution_identity_event_missing",
        message: "Execution identify completed without publishing its resolved selection.",
      };
    }
    return this.currentTarget();
  }

  async ensureStarted(
    request: ExecutionPlatformRequest,
    identity: ExecutionPlatformIdentity,
    refresh = false,
  ): Promise<JarvisBehaviorExecutionTargetResult> {
    this.observeExecution();
    if (!this.selection || !sameIdentity(this.selection.platform, identity)) {
      return {
        ok: false,
        code: "execution_target_changed",
        message: "The identified execution target changed before launch.",
      };
    }
    if (this.started && !refresh) return this.currentTarget();

    const result = await currentRunScope().executionSystem.launch({
      identity: this.selection,
      ...(request.appId ? { appId: request.appId } : {}),
      ...(request.parameters ? { parameters: request.parameters } : {}),
    }, {
      correlationId: this.nextCorrelationId("launch"),
    });
    if (!result.ok) return result;
    if (!this.started || !sameIdentity(result.identity, identity)) {
      return {
        ok: false,
        code: "execution_launch_event_missing",
        message: "Execution launch completed without confirming the identified target.",
      };
    }
    return this.currentTarget();
  }

  async ensureStopped(
    request: ExecutionPlatformRequest,
    identity: ExecutionPlatformIdentity,
  ): Promise<JarvisBehaviorExecutionTargetResult> {
    this.observeExecution();
    if (!this.selection || !sameIdentity(this.selection.platform, identity)) {
      return {
        ok: false,
        code: "execution_target_changed",
        message: "The identified execution target changed before shutdown.",
      };
    }
    if (!this.started) return this.currentTarget();

    const result = await currentRunScope().executionSystem.shutdown({
      identity: this.selection,
      ...(request.appId ? { appId: request.appId } : {}),
    }, {
      correlationId: this.nextCorrelationId("shutdown"),
    });
    if (!result.ok) return result;
    if (this.started || !sameIdentity(result.identity, identity)) {
      return {
        ok: false,
        code: "execution_shutdown_event_missing",
        message: "Execution shutdown completed without releasing the identified target.",
      };
    }
    return this.currentTarget();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.selection = undefined;
    this.started = false;
  }

  restore(fact: RbtRuntimeFact): void {
    this.selection = fact.execution
      ? structuredClone(fact.execution.selection)
      : undefined;
    this.started = fact.execution?.state === "launched";
  }

  private observeExecution(): void {
    if (this.unsubscribe.length > 0) return;
    const eventBus = currentRunScope().eventBus;
    this.unsubscribe.push(
      eventBus.subscribe<ExecutionCommandCompletedEvent>(
        ExecutionEvents.execution.identifyCompleted,
        (event) => this.acceptIdentify(event.payload),
      ),
      eventBus.subscribe<ExecutionCommandCompletedEvent>(
        ExecutionEvents.execution.launchCompleted,
        (event) => this.acceptLaunch(event.payload),
      ),
      eventBus.subscribe<ExecutionCommandCompletedEvent>(
        ExecutionEvents.execution.shutdownCompleted,
        (event) => this.acceptShutdown(event.payload),
      ),
    );
  }

  private acceptIdentify(event: ExecutionCommandCompletedEvent): void {
    if (!event.result.ok) {
      this.selection = undefined;
      this.started = false;
      return;
    }
    const sameTarget = this.selection
      && sameSelection(this.selection, event.result.selection);
    this.selection = structuredClone(event.result.selection);
    if (!sameTarget) this.started = false;
  }

  private acceptLaunch(event: ExecutionCommandCompletedEvent): void {
    if (!event.result.ok) {
      if (event.result.requiresIdentify) this.selection = undefined;
      this.started = false;
      return;
    }
    this.selection = structuredClone(event.result.selection);
    this.started = true;
  }

  private acceptShutdown(event: ExecutionCommandCompletedEvent): void {
    if (event.result.ok) {
      this.selection = structuredClone(event.result.selection);
      this.started = false;
      return;
    }
    if (event.result.requiresIdentify) this.selection = undefined;
  }

  private selectionMatches(request: ExecutionPlatformRequest): boolean {
    return Boolean(this.selection
      && (!request.transport || request.transport === this.selection.transport)
      && (!request.platform || request.platform === this.selection.platform.type));
  }

  private currentTarget(): Extract<JarvisBehaviorExecutionTargetResult, { ok: true }> {
    if (!this.selection) throw new Error("Execution target is unavailable.");
    return {
      ok: true,
      identity: structuredClone(this.selection.platform),
      started: this.started,
    };
  }

  private nextCorrelationId(operation: string): string {
    this.sequence += 1;
    return `rbt-${operation}-${String(this.sequence).padStart(6, "0")}`;
  }
}

function sameSelection(left: ExecutionSelectionIdentity, right: ExecutionSelectionIdentity): boolean {
  return left.transport === right.transport && sameIdentity(left.platform, right.platform);
}

function sameIdentity(left: ExecutionPlatformIdentity, right: ExecutionPlatformIdentity): boolean {
  return left.type === right.type && left.version === right.version;
}

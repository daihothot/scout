import { isDeepStrictEqual } from "node:util";
import type { EventBus, ScoutEvent, UnsubscribeEventHandler } from "../../../../core/events/index.js";
import {
  ExecutionEvents,
  type ExecutionPlatformPort,
  type ExecutionPlatformRequest,
  type ExecutionSelectionIdentity,
} from "../../../../execution/index.js";
import type { BaseDomainRuntimeFact } from "../projector/base-domain-projector.js";
import {
  projectBaseExecutionEvent,
  sameExecutionSelection,
  type BaseDomainExecutionState,
} from "./base-domain-execution-state.js";

export type BaseDomainExecutionResult =
  | { ok: true; identity: ExecutionSelectionIdentity; started: boolean }
  | { ok: false; code: string; message: string };

/** A fresh launch carries the receipt needed for conditional failure cleanup. */
export type BaseDomainExecutionStartResult =
  | ({ ok: true; identity: ExecutionSelectionIdentity; started: true } & (
    | { launched: true; launchId: string }
    | { launched: false }
  ))
  | Extract<BaseDomainExecutionResult, { ok: false }>;

/** Shared execution authority restored and operated entirely by Base Domain. */
export class BaseDomainExecution {
  private state?: BaseDomainExecutionState;
  private configuration?: Omit<ExecutionPlatformRequest, "identity">;
  private sequence = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private rollbackLaunchId?: string;
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];

  constructor(
    private readonly eventBus: EventBus,
    private readonly executionSystem: ExecutionPlatformPort,
  ) {}

  /** Accepts runtime configuration; Agent calls never supply or override it. */
  configure(configuration: Omit<ExecutionPlatformRequest, "identity">): void {
    if (this.configuration && !isDeepStrictEqual(this.configuration, configuration)) {
      throw new Error("The shared execution runtime already has a different configuration.");
    }
    this.configuration = structuredClone(configuration);
  }

  /** Starts the configured target, reusing an already confirmed matching session. */
  async launch(): Promise<BaseDomainExecutionResult> {
    if (!this.configuration) {
      return { ok: false, code: "execution_not_configured", message: "The execution runtime has no launch configuration." };
    }
    const request = structuredClone(this.configuration);
    return this.enqueue(async () => {
      const target = await this.resolveTarget(request);
      return target.ok ? this.startTarget(request, target.identity) : target;
    });
  }

  /** Stops the actual owned session, including one restored from Journal facts. */
  shutdown(): Promise<BaseDomainExecutionResult> {
    return this.enqueue(async () => {
      this.observeExecution();
      if (!this.state) {
        return { ok: false, code: "execution_target_unavailable", message: "There is no confirmed execution session to shut down." };
      }
      return this.stopTarget({ appId: this.state.appId }, structuredClone(this.state.selection));
    });
  }

  resolve(request: ExecutionPlatformRequest): Promise<BaseDomainExecutionResult> {
    const input = structuredClone(request);
    return this.enqueue(() => this.resolveTarget(input));
  }

  current(request: ExecutionPlatformRequest): BaseDomainExecutionResult {
    this.observeExecution();
    if (!this.state) {
      return { ok: false, code: "execution_target_unavailable", message: "The Base Domain execution target has not been identified." };
    }
    if (!this.selectionMatches(request)
      || (this.state.state !== "identified" && this.state.appId !== request.appId?.trim())) {
      return { ok: false, code: "execution_target_changed", message: "The Base Domain execution target does not match the requested target." };
    }
    if (this.state.state === "launched") this.rollbackLaunchId = undefined;
    return this.currentTarget();
  }

  ensureStarted(
    request: ExecutionPlatformRequest,
    identity: ExecutionSelectionIdentity,
  ): Promise<BaseDomainExecutionStartResult> {
    const input = structuredClone(request);
    const expected = structuredClone(identity);
    return this.enqueue(() => this.startTarget(input, expected));
  }

  ensureStopped(
    request: ExecutionPlatformRequest,
    identity: ExecutionSelectionIdentity,
  ): Promise<BaseDomainExecutionResult> {
    const input = structuredClone(request);
    const expected = structuredClone(identity);
    return this.enqueue(() => this.stopTarget(input, expected));
  }

  /** Rolls back only this launch, and only while no other caller has reused it. */
  rollbackStart(
    request: ExecutionPlatformRequest,
    identity: ExecutionSelectionIdentity,
    launchId: string,
  ): Promise<{ ok: true } | Extract<BaseDomainExecutionResult, { ok: false }>> {
    const input = structuredClone(request);
    const expected = structuredClone(identity);
    return this.enqueue(async () => {
      if (this.rollbackLaunchId !== launchId) return { ok: true };
      const result = await this.stopTarget(input, expected);
      return result.ok ? { ok: true } : result;
    });
  }

  restore(fact: BaseDomainRuntimeFact): void {
    this.state = structuredClone(fact.execution);
    this.rollbackLaunchId = undefined;
  }

  /** Lifecycle owners wait for accepted execution work before clearing their runtime. */
  async drain(): Promise<void> { await this.operationTail; }

  stop(): void {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.state = undefined;
    this.rollbackLaunchId = undefined;
  }

  private async resolveTarget(input: ExecutionPlatformRequest): Promise<BaseDomainExecutionResult> {
    this.observeExecution();
    if (this.state?.state === "launched") {
      if (!this.selectionMatches(input) || this.state.appId !== input.appId?.trim()) {
        return { ok: false, code: "execution_target_conflict", message: "Stop the running application before selecting another execution target." };
      }
      this.rollbackLaunchId = undefined;
      return this.currentTarget();
    }
    if (this.selectionMatches(input)) return this.currentTarget();
    const result = await this.executionSystem.identify({
      ...(input.transport ? { transport: input.transport } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
    }, {
      correlationId: this.nextCorrelationId("identify"),
    });
    if (!result.ok) return result;
    if (!this.state || !this.selectionMatches(input)
      || this.state.selection.platform.type !== result.identity.type
      || this.state.selection.platform.version !== result.identity.version) {
      return { ok: false, code: "execution_identity_event_missing", message: "Execution identify completed without publishing the requested selection." };
    }
    return this.currentTarget();
  }

  private async startTarget(
    input: ExecutionPlatformRequest,
    expected: ExecutionSelectionIdentity,
  ): Promise<BaseDomainExecutionStartResult> {
    this.observeExecution();
    if (!this.state || !sameExecutionSelection(this.state.selection, expected)
      || !this.selectionMatches(input)) {
      return { ok: false, code: "execution_target_changed", message: "The identified execution target changed before launch." };
    }
    if (this.state.state === "launched") {
      if (this.state.appId !== input.appId?.trim()) {
        return { ok: false, code: "execution_target_conflict", message: "Another application is already running on the shared execution target." };
      }
      this.rollbackLaunchId = undefined;
      return { ok: true, identity: structuredClone(this.state.selection), started: true, launched: false };
    }
    const launchId = this.nextCorrelationId("launch");
    this.rollbackLaunchId = launchId;
    try {
      const result = await this.executionSystem.launch({
        identity: expected,
        ...(input.appId !== undefined ? { appId: input.appId } : {}),
        ...(input.parameters !== undefined ? { parameters: input.parameters } : {}),
      }, { correlationId: launchId });
      if (!result.ok) {
        this.rollbackLaunchId = undefined;
        return result;
      }
      if (!this.state) {
        this.rollbackLaunchId = undefined;
        return { ok: false, code: "execution_launch_event_missing", message: "Execution launch completed without confirming the identified application." };
      }
      const confirmed = this.currentTarget();
      if (!confirmed.started || !sameExecutionSelection(confirmed.identity, expected)
        || this.state.appId !== input.appId?.trim()) {
        this.rollbackLaunchId = undefined;
        return { ok: false, code: "execution_launch_event_missing", message: "Execution launch completed without confirming the identified application." };
      }
      return { ok: true, identity: confirmed.identity, started: true, launched: true, launchId };
    } catch (error) {
      this.rollbackLaunchId = undefined;
      throw error;
    }
  }

  private async stopTarget(
    request: ExecutionPlatformRequest,
    identity: ExecutionSelectionIdentity,
  ): Promise<BaseDomainExecutionResult> {
    this.observeExecution();
    if (!this.state || !sameExecutionSelection(this.state.selection, identity)
      || !this.selectionMatches(request)) {
      return { ok: false, code: "execution_target_changed", message: "The identified execution target changed before shutdown." };
    }
    if (this.state.state !== "identified" && this.state.appId !== request.appId?.trim()) {
      return { ok: false, code: "execution_target_conflict", message: "Shutdown must name the application owned by the shared execution target." };
    }
    if (this.state.state !== "launched") return this.currentTarget();
    const result = await this.executionSystem.shutdown({
      identity,
      ...(request.appId !== undefined ? { appId: request.appId } : {}),
    }, { correlationId: this.nextCorrelationId("shutdown") });
    if (!result.ok) return result;
    if (!this.state) {
      return { ok: false, code: "execution_shutdown_event_missing", message: "Execution shutdown completed without confirming the identified application." };
    }
    const confirmed = this.currentTarget();
    if (confirmed.started || !sameExecutionSelection(confirmed.identity, identity)) {
      return { ok: false, code: "execution_shutdown_event_missing", message: "Execution shutdown completed without releasing the identified application." };
    }
    return confirmed;
  }

  private observeExecution(): void {
    if (this.unsubscribers.length > 0) return;
    const accept = (event: ScoutEvent) => {
      this.state = projectBaseExecutionEvent(this.state, event);
      if (!ExecutionEvents.execution.launchCompleted.is(event)
        || !event.payload.result.ok
        || event.payload.correlationId !== this.rollbackLaunchId) {
        this.rollbackLaunchId = undefined;
      }
    };
    this.unsubscribers.push(
      this.eventBus.subscribe(ExecutionEvents.execution.identifyCompleted, accept),
      this.eventBus.subscribe(ExecutionEvents.execution.launchCompleted, accept),
      this.eventBus.subscribe(ExecutionEvents.execution.shutdownCompleted, accept),
    );
  }

  private selectionMatches(request: ExecutionPlatformRequest): boolean {
    return Boolean(this.state
      && (!request.transport || request.transport.trim() === this.state.selection.transport)
      && (!request.platform || request.platform.trim() === this.state.selection.platform.type)
      && (!request.identity || sameExecutionSelection(request.identity, this.state.selection)));
  }

  private currentTarget(): Extract<BaseDomainExecutionResult, { ok: true }> {
    if (!this.state) throw new Error("Execution target is unavailable.");
    return {
      ok: true,
      identity: structuredClone(this.state.selection),
      started: this.state.state === "launched",
    };
  }

  private nextCorrelationId(operation: string): string {
    this.sequence += 1;
    return "base-execution-" + operation + "-" + String(this.sequence).padStart(6, "0");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

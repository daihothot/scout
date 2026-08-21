import type {
  AppServerPlanState,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import type { CodexAppServerClient } from "../../agent-server/codex/app-server-client.js";
import type { AssetCommit } from "../../asset-store/contracts/asset-commit.js";
import type { CodexMount } from "../../asset-store/contracts/mount.js";
import type { Result } from "../../core/result.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import type { AgentTaskState, SendAgentMessageInput } from "../task/types.js";
import type { AgentMessage } from "../message/types.js";
import type {
  AgentThreadSnapshot,
  AgentThreadSpec,
} from "../thread/types.js";
import {
  runThreadPreflight,
  type ScoutAgentThreadPreflightSnapshot,
} from "../thread/thread-preflight.js";
import { AgentEvents } from "../events/index.js";
import { attachments } from "../context/attachments.js";
import { randomUUID } from "node:crypto";

/** Input contract for one app-server turn owned by a Scout agent. */
export interface ScoutAgentTurnInput {
  prompt: string;
  outputContract?: string;
  timeoutMs?: number;
  onStatusMessage?: (message: string) => void;
  onTurnStarted?(invocationId: string): void | Promise<void>;
}

/** Durable lifecycle record for one agent turn invocation. */
export interface ScoutAgentTurnRecord {
  invocationId: string;
  agentId: string;
  role: AgentThreadSpec["role"];
  threadId: string;
  turnId?: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "failed" | "interrupted";
  outputContract?: string;
  error?: string;
}

/** Turn result plus app-server projections consumed by Agent execution policy. */
export interface ScoutAgentTurnOutcome {
  turn: ScoutAgentTurnRecord;
  finalResponse?: string;
  plan?: AppServerPlanState;
  goal?: AppServerThreadGoalState;
}

/** Result of attempting to append input to an active turn. */
export type ScoutAgentSteerResult =
  | { steered: true; turnId: string }
  | { steered: false };

/** Snapshot exposed to run persistence and resume assembly. */
export interface ScoutAgentSnapshot {
  agentId: string;
  thread?: AgentThreadSnapshot;
  activeTask?: AgentTaskState;
  pendingMessageCount: number;
}

/** Prepared mount and tool inputs needed to construct a Scout agent. */
export interface ScoutAgentOptions {
  agentId?: string;
  agentMount: CodexMount;
  assetCommit: AssetCommit;
  dynamicTools?: AgentThreadSpec["dynamicTools"];
}

interface InFlightTurnOwnership {
  invocationId: string;
  threadId: string;
  turnId?: string;
  completed: boolean;
  interruptRequested: boolean;
  interruptPromise?: Promise<void>;
  turnIdReady: Promise<string | undefined>;
  resolveTurnId(turnId: string | undefined): void;
}

const AGENT_STOP_TIMEOUT_MS = 5_000;

class AgentTurnInterruptedError extends Error {
  override readonly name = "AgentTurnInterruptedError";
}

/**
 * Owns one role's app-server thread, turn lifecycle, and registry identity.
 * Concrete role agents provide execution behavior; this base keeps thread and
 * interruption facts consistent for startup, telemetry, and resume.
 */
export abstract class ScoutAgent {
  readonly agentId: string;
  readonly spec: AgentThreadSpec;
  protected readonly runScope: RunScope;
  protected readonly appServer: RunScope["appServer"];
  protected readonly contextBundle: RunScope["contextBundle"];
  protected readonly agentMount: CodexMount;
  protected readonly assetCommit: AssetCommit;
  protected readonly eventBus: RunScope["eventBus"];
  protected readonly registry: RunScope["agentRegistry"];
  private thread?: AgentThreadSnapshot;
  private threadPreflight?: ScoutAgentThreadPreflightSnapshot;
  private threadPreflightPromise?: Promise<void>;
  private invocationSequence = 0;
  private inFlightTurn?: InFlightTurnOwnership;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private readonly acceptedMessages = new Map<string, AgentMessage>();
  private pendingMessages: AgentMessage[] = [];
  private messageDeliveryChain: Promise<void> = Promise.resolve();

  constructor(input: ScoutAgentOptions & {
    spec: AgentThreadSpec;
  }) {
    const scope = currentRunScope();
    this.agentId = input.agentId ?? input.spec.role;
    this.spec = input.spec;
    this.runScope = scope;
    this.appServer = scope.appServer;
    this.contextBundle = scope.contextBundle;
    this.agentMount = input.agentMount;
    this.assetCommit = input.assetCommit;
    this.eventBus = scope.eventBus;
    this.registry = scope.agentRegistry;
  }

  get role(): AgentThreadSpec["role"] {
    return this.spec.role;
  }

  get phases(): AgentThreadSpec["phases"] {
    return this.spec.phases;
  }

  get threadSnapshot(): AgentThreadSnapshot | undefined {
    return this.thread;
  }

  get threadId(): string | undefined {
    return this.thread?.threadId;
  }

  get threadPreflightSnapshot(): ScoutAgentThreadPreflightSnapshot | undefined {
    return this.threadPreflight;
  }

  get mount(): CodexMount {
    return this.agentMount;
  }

  abstract sendMessage(input: SendAgentMessageInput): Promise<Result<void, string>>;

  protected abstract stopExecution(reason: string): Promise<void>;

  protected taskSnapshot(): AgentTaskState | undefined {
    return undefined;
  }

  protected get isStopping(): boolean {
    return this.stopping;
  }

  protected get pendingMessageCount(): number {
    return this.pendingMessages.length;
  }

  protected pendingMessagesSnapshot(): AgentMessage[] {
    return structuredClone(this.pendingMessages);
  }

  protected enqueueMessageDelivery(input: SendAgentMessageInput, options: {
    taskId?: string;
    deliveryName: string;
    onAccepted?: (message: AgentMessage) => void | Promise<void>;
  }): Promise<boolean> {
    let acceptedNewMessage = false;
    const delivery = this.messageDeliveryChain.then(async () => {
      const message: AgentMessage = {
        messageId: input.delivery?.messageId ?? `${this.agentId}-message-${randomUUID()}`,
        agentId: this.agentId,
        ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
        body: attachments.compose(input.message),
        queuedAt: input.delivery?.queuedAt ?? new Date().toISOString(),
        ...(input.deliveryMode === undefined ? {} : { deliveryMode: input.deliveryMode }),
      };
      const accepted = this.acceptedMessages.get(message.messageId);
      if (accepted && !sameAgentMessage(accepted, message)) {
        throw new Error(`Message ${message.messageId} does not match its ${options.deliveryName} delivery.`);
      }
      if (accepted) return;
      acceptedNewMessage = true;
      this.acceptedMessages.set(message.messageId, structuredClone(message));
      this.pendingMessages = [...this.pendingMessages, message];
      this.eventBus.publish(AgentEvents.message.queued, message, { occurredAt: message.queuedAt });
      await options.onAccepted?.(message);
      if (message.deliveryMode !== "queued") {
        const steered = await this.steerActiveTurn({
          message: message.body,
          messageId: message.messageId,
        });
        if (steered.steered) {
          this.pendingMessages = this.pendingMessages.filter((candidate) =>
            candidate.messageId !== message.messageId
          );
          this.publishMessageConsumed(message, "steer", steered.turnId);
        }
      }
    });
    this.messageDeliveryChain = delivery.catch(() => undefined);
    return delivery.then(() => acceptedNewMessage);
  }

  protected consumeQueuedMessages(messages: AgentMessage[], stepId: string): void {
    const consumed = new Set(messages.map((message) => message.messageId));
    this.pendingMessages = this.pendingMessages.filter((message) =>
      !consumed.has(message.messageId)
    );
    for (const message of messages) this.publishMessageConsumed(message, "queued", undefined, stepId);
  }

  protected clearPendingMessages(): void {
    this.pendingMessages = [];
  }

  protected restoreMessageState(input: {
    acceptedMessages: AgentMessage[];
    pendingMessages: AgentMessage[];
    deliveryName: string;
  }): void {
    if (this.acceptedMessages.size > 0 || this.pendingMessages.length > 0) {
      throw new Error(`Agent ${this.agentId} message state is already restored.`);
    }
    this.pendingMessages = structuredClone(input.pendingMessages);
    for (const message of [...input.acceptedMessages, ...this.pendingMessages]) {
      const accepted = this.acceptedMessages.get(message.messageId);
      if (accepted && !sameAgentMessage(accepted, message)) {
        throw new Error(`Message ${message.messageId} does not match its ${input.deliveryName} delivery.`);
      }
      this.acceptedMessages.set(message.messageId, structuredClone(message));
    }
  }

  private publishMessageConsumed(
    message: AgentMessage,
    deliveryMode: "steer" | "queued",
    turnId?: string,
    stepId?: string,
  ): void {
    const runningSteps = this.runScope.stepStore.list({ agentId: this.agentId }).filter((step) =>
      step.status === "running" && (stepId === undefined || step.stepId === stepId)
    );
    if (runningSteps.length !== 1 || !runningSteps[0]) {
      throw new Error(`Agent ${this.agentId} must have exactly one running step to consume message ${message.messageId}.`);
    }
    const runningStep = runningSteps[0];
    if (turnId && runningStep.turnId && runningStep.turnId !== turnId) {
      throw new Error(
        `Agent step ${runningStep.stepId} belongs to turn ${runningStep.turnId}, not ${turnId}.`,
      );
    }
    const consumedAt = new Date().toISOString();
    this.eventBus.publish(AgentEvents.message.consumed, {
      messageId: message.messageId,
      agentId: message.agentId,
      stepId: runningStep.stepId,
      taskId: message.taskId,
      consumedAt,
      deliveryMode,
      ...(turnId === undefined ? {} : { turnId }),
    }, { occurredAt: consumedAt });
  }

  async startThread(): Promise<AgentThreadSnapshot> {
    if (this.thread?.status === "active") return this.thread;
    if (this.thread) {
      throw new Error(`Agent ${this.agentId} thread is closed.`);
    }
    const thread = await this.openNewThread();
    this.eventBus.publish(AgentEvents.thread.started, structuredClone(thread));
    await this.checkThread(thread);
    return thread;
  }

  async restartThread(input: {
    previousThread: AgentThreadSnapshot;
    reason: string;
  }): Promise<AgentThreadSnapshot> {
    if (
      input.previousThread.agentId !== this.agentId
      || input.previousThread.role !== this.role
    ) {
      throw new Error(
        `Thread ${input.previousThread.threadId} does not belong to agent ${this.agentId}.`,
      );
    }
    if (this.thread?.status === "active") return this.thread;
    if (this.thread) {
      throw new Error(`Agent ${this.agentId} thread is closed.`);
    }
    const thread = await this.openNewThread();
    const restartedAt = thread.createdAt;
    this.eventBus.publish(AgentEvents.thread.restarted, {
      previousThreadId: input.previousThread.threadId,
      reason: input.reason,
      restartedAt,
      newThread: structuredClone(thread),
    }, {
      occurredAt: restartedAt,
    });
    await this.checkThread(thread);
    return thread;
  }

  private async openNewThread(): Promise<AgentThreadSnapshot> {
    const started = await this.appServer.startThread({
      model: this.spec.model.id,
      modelProvider: this.spec.model.provider,
      reasoningEffort: this.spec.model.reasoningEffort,
      cwd: this.spec.cwd,
      runtimeWorkspaceRoots: [this.spec.cwd],
      approvalPolicy: this.spec.approvalPolicy,
      permissions: this.spec.permissionProfile,
      ephemeral: false,
      config: this.spec.config,
      baseInstructions: this.spec.baseInstructions,
      developerInstructions: this.spec.developerInstructions,
      dynamicTools: this.spec.dynamicTools,
    });
    this.thread = {
      agentId: this.agentId,
      role: this.spec.role,
      phases: [...this.spec.phases],
      contextBundleId: this.spec.contextBundleId,
      threadId: started.threadId,
      createdAt: new Date().toISOString(),
      status: "active",
      startInput: started.startInput,
      startResponse: started.response,
    };
    this.registry.bindThread(this.agentId, this.thread.threadId);
    return this.thread;
  }

  async resumeThread(input: {
    thread: AgentThreadSnapshot;
    invocationSequence: number;
    rolloutPath: string;
  }): Promise<AgentThreadSnapshot> {
    if (this.thread?.status === "active") return this.thread;
    if (this.thread) {
      throw new Error(`Agent ${this.agentId} thread is closed.`);
    }
    if (input.thread.agentId !== this.agentId || input.thread.role !== this.role) {
      throw new Error(
        `Thread ${input.thread.threadId} does not belong to agent ${this.agentId}.`,
      );
    }
    if (input.thread.startInput.ephemeral) {
      throw new Error(`Thread ${input.thread.threadId} is ephemeral and cannot be resumed.`);
    }
    if (
      !Number.isInteger(input.invocationSequence)
      || input.invocationSequence < 0
    ) {
      throw new Error(`Invalid invocation sequence for agent ${this.agentId}.`);
    }
    const resumed = await this.appServer.resumeThread({
      threadId: input.thread.threadId,
      path: input.rolloutPath,
      model: this.spec.model.id,
      modelProvider: this.spec.model.provider,
      reasoningEffort: this.spec.model.reasoningEffort,
      cwd: this.spec.cwd,
      runtimeWorkspaceRoots: [this.spec.cwd],
      approvalPolicy: this.spec.approvalPolicy,
      permissions: this.spec.permissionProfile,
      config: this.spec.config,
      baseInstructions: this.spec.baseInstructions,
      developerInstructions: this.spec.developerInstructions,
    });
    const {
      closedAt: _closedAt,
      closeReason: _closeReason,
      ...thread
    } = input.thread;
    this.thread = {
      ...thread,
      status: "active",
    };
    this.invocationSequence = input.invocationSequence;
    this.registry.bindThread(this.agentId, this.thread.threadId);
    const resumedAt = new Date().toISOString();
    this.eventBus.publish(AgentEvents.thread.resumed, {
      agentId: this.agentId,
      role: this.role,
      threadId: this.thread.threadId,
      resumedAt,
      resumeInput: resumed.resumeInput,
      resumeResponse: resumed.response,
    }, {
      occurredAt: resumedAt,
    });
    await this.checkThread(this.thread);
    return this.thread;
  }

  async stopAgent(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.stopAgentOnce(reason);
    return this.stopPromise;
  }

  private async stopAgentOnce(reason: string): Promise<void> {
    // Stop scheduling synchronously before the current turn can roll over.
    const executionStop = this.stopExecution(reason);
    void executionStop.catch(() => undefined);
    const errors: unknown[] = [];
    try {
      try {
        await withTimeout(
          this.interruptOwnedTurn(),
          AGENT_STOP_TIMEOUT_MS,
          `Timed out interrupting the active turn for agent ${this.agentId}.`,
        );
      } catch (error) {
        errors.push(error);
        this.cancelOwnedTurnWait(error);
      }
      try {
        await withTimeout(
          executionStop,
          AGENT_STOP_TIMEOUT_MS,
          `Timed out stopping execution for agent ${this.agentId}.`,
        );
      } catch (error) {
        errors.push(error);
        this.cancelOwnedTurnWait(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `Agent ${this.agentId} failed to stop cleanly.`);
      }
    } finally {
      if (this.thread?.status === "active") {
        this.thread = {
          ...this.thread,
          status: "closed",
          closedAt: new Date().toISOString(),
          closeReason: reason,
        };
        this.eventBus.publish(AgentEvents.thread.closed, structuredClone(this.thread));
      }
    }
  }

  private interruptOwnedTurn(): Promise<void> {
    const ownership = this.inFlightTurn;
    if (!ownership) return Promise.resolve();
    ownership.interruptRequested = true;
    return this.ensureOwnedTurnInterrupt(ownership);
  }

  private ensureOwnedTurnInterrupt(ownership: InFlightTurnOwnership): Promise<void> {
    ownership.interruptPromise ??= this.interruptOwnedTurnOnce(ownership);
    return ownership.interruptPromise;
  }

  private async interruptOwnedTurnOnce(ownership: InFlightTurnOwnership): Promise<void> {
    const turnId = ownership.turnId ?? await ownership.turnIdReady;
    if (!turnId || ownership.completed) return;

    try {
      await this.appServer.interruptTurn({
        threadId: ownership.threadId,
        turnId,
      });
    } catch (error) {
      const turn = this.appServer.turnSnapshot(ownership.threadId, turnId);
      if (ownership.completed || turn?.completedAt || isTerminalTurnStatus(turn?.status)) {
        return;
      }
      throw error;
    }
  }

  assertOwnsActiveTurn(input: { threadId: string; turnId: string }): void {
    const ownership = this.inFlightTurn;
    if (!ownership || ownership.completed) {
      throw new Error(
        `Agent ${this.agentId} has no active app-server turn for lifecycle tool delivery.`,
      );
    }
    if (ownership.threadId !== input.threadId) {
      throw new Error(
        `Agent ${this.agentId} owns thread ${ownership.threadId}, not ${input.threadId}.`,
      );
    }
    if (!ownership.turnId) {
      throw new Error(`Agent ${this.agentId} has not bound its active app-server turn yet.`);
    }
    if (ownership.turnId !== input.turnId) {
      throw new Error(
        `Agent ${this.agentId} owns active app-server turn ${ownership.turnId}, not ${input.turnId}.`,
      );
    }
  }

  private cancelOwnedTurnWait(error: unknown): void {
    const ownership = this.inFlightTurn;
    if (!ownership || ownership.completed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.appServer.cancelTurnWait(
      ownership.threadId,
      new AgentTurnInterruptedError(message),
    );
  }

  async runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome> {
    const thread = this.thread;
    if (!thread || thread.status !== "active") {
      throw new Error(`Agent ${this.agentId} thread is not active.`);
    }
    if (this.stopping) {
      throw new Error(`Agent ${this.agentId} is stopping and cannot start another turn.`);
    }
    const invocationId = this.nextInvocationId(thread.threadId);
    const startedAt = new Date().toISOString();
    const activeTask = this.runScope.taskStore.findActiveTaskForAgent(this.agentId);
    this.eventBus.publish(AgentEvents.turn.started, {
      invocationId,
      agentId: this.agentId,
      role: this.role,
      taskId: activeTask?.taskId,
      threadId: thread.threadId,
      prompt: input.prompt,
      startedAt,
    }, {
      occurredAt: startedAt,
    });
    await input.onTurnStarted?.(invocationId);

    if (this.stopping) {
      const turn = this.interruptedBeforeStartTurn({
        invocationId,
        thread,
        startedAt,
        outputContract: input.outputContract,
      });
      this.eventBus.publish(AgentEvents.turn.completed, {
        taskId: activeTask?.taskId,
        turn,
      }, {
        occurredAt: turn.finishedAt,
      });
      return { turn };
    }

    const ownership = this.claimTurnOwnership(invocationId, thread.threadId);

    let result: Awaited<ReturnType<CodexAppServerClient["runTurn"]>>;
    try {
      result = await this.appServer.runTurn({
        threadId: thread.threadId,
        prompt: input.prompt,
        model: this.spec.model.id,
        reasoningEffort: this.spec.model.reasoningEffort,
        reasoningSummary: this.spec.model.reasoningSummary,
        timeoutMs: input.timeoutMs,
        permissions: this.spec.permissionProfile,
        onStatusMessage: input.onStatusMessage,
        onTurnStarted: (turnId) => this.bindOwnedTurnId(ownership, turnId),
      });
    } catch (error) {
      const turnId = ownership.turnId;
      this.releaseTurnOwnership(ownership);
      const turn: ScoutAgentTurnRecord = {
        invocationId,
        agentId: this.agentId,
        role: this.spec.role,
        threadId: thread.threadId,
        turnId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: error instanceof AgentTurnInterruptedError ? "interrupted" : "failed",
        outputContract: input.outputContract,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      };
      this.eventBus.publish(AgentEvents.turn.completed, {
        taskId: activeTask?.taskId,
        turn,
      }, {
        occurredAt: turn.finishedAt,
      });
      return { turn };
    }
    this.releaseTurnOwnership(ownership);

    const resolvedStatus = result.turnSnapshot?.status;
    const status: ScoutAgentTurnRecord["status"] = resolvedStatus === undefined
      || resolvedStatus === "completed"
      ? "completed"
      : resolvedStatus === "interrupted"
      ? "interrupted"
      : "failed";
    const snapshotError = result.turnSnapshot?.error;
    const turnError = status === "completed"
      ? undefined
      : snapshotError === undefined || snapshotError === null
      ? resolvedStatus && resolvedStatus !== status
        ? `Unexpected app-server turn status: ${resolvedStatus}`
        : undefined
      : formatTurnError(snapshotError);
    const turn: ScoutAgentTurnRecord = {
      invocationId,
      agentId: this.agentId,
      role: this.spec.role,
      threadId: thread.threadId,
      turnId: result.turnId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      outputContract: input.outputContract,
      error: turnError,
    };
    this.eventBus.publish(AgentEvents.turn.completed, {
      taskId: activeTask?.taskId,
      turn,
    }, {
      occurredAt: turn.finishedAt,
    });
    return {
      turn,
      finalResponse: result.finalResponse,
      plan: result.plan,
      goal: result.goal,
    };
  }

  /**
   * Attempts to append a message to this agent's active app-server turn.
   * `{ steered: false }` means the turn completed (or never became active)
   * before steer could be submitted; callers should then enqueue the message
   * for a fresh turn.
   */
  async steerActiveTurn(input: {
    message: string;
    messageId?: string;
  }): Promise<ScoutAgentSteerResult> {
    if (typeof this.appServer.steerTurn !== "function") return { steered: false };
    const ownership = this.inFlightTurn;
    if (!ownership || ownership.completed) return { steered: false };
    const turnId = ownership.turnId ?? await ownership.turnIdReady;
    if (!turnId || ownership.completed) return { steered: false };
    try {
      await this.appServer.steerTurn({
        threadId: ownership.threadId,
        expectedTurnId: turnId,
        prompt: input.message,
        clientUserMessageId: input.messageId,
      });
      return { steered: true, turnId };
    } catch (error) {
      const turn = this.appServer.turnSnapshot(ownership.threadId, turnId);
      if (
        ownership.completed
        || turn?.completedAt
        || isTerminalTurnStatus(turn?.status)
      ) {
        return { steered: false };
      }
      throw error;
    }
  }

  private claimTurnOwnership(
    invocationId: string,
    threadId: string,
  ): InFlightTurnOwnership {
    if (this.inFlightTurn) {
      throw new Error(
        `Agent ${this.agentId} already owns in-flight turn ${this.inFlightTurn.invocationId}.`,
      );
    }
    let resolveTurnId: (turnId: string | undefined) => void = () => undefined;
    const ownership: InFlightTurnOwnership = {
      invocationId,
      threadId,
      completed: false,
      interruptRequested: false,
      turnIdReady: new Promise((resolve) => {
        resolveTurnId = resolve;
      }),
      resolveTurnId: (turnId) => resolveTurnId(turnId),
    };
    this.inFlightTurn = ownership;
    return ownership;
  }

  private bindOwnedTurnId(ownership: InFlightTurnOwnership, turnId: string): void {
    if (this.inFlightTurn !== ownership || ownership.completed) return;
    if (ownership.turnId && ownership.turnId !== turnId) {
      throw new Error(
        `Agent ${this.agentId} in-flight turn changed from ${ownership.turnId} to ${turnId}.`,
      );
    }
    ownership.turnId = turnId;
    ownership.resolveTurnId(turnId);
    if (ownership.interruptRequested) {
      void this.ensureOwnedTurnInterrupt(ownership).catch(() => undefined);
    }
  }

  private releaseTurnOwnership(ownership: InFlightTurnOwnership): void {
    ownership.completed = true;
    ownership.resolveTurnId(undefined);
    if (this.inFlightTurn === ownership) this.inFlightTurn = undefined;
  }

  private interruptedBeforeStartTurn(input: {
    invocationId: string;
    thread: AgentThreadSnapshot;
    startedAt: string;
    outputContract?: string;
  }): ScoutAgentTurnRecord {
    return {
      invocationId: input.invocationId,
      agentId: this.agentId,
      role: this.spec.role,
      threadId: input.thread.threadId,
      startedAt: input.startedAt,
      finishedAt: new Date().toISOString(),
      status: "interrupted",
      outputContract: input.outputContract,
      error: "Agent stop requested before the app-server turn started.",
    };
  }

  async setThreadGoal(input: {
    objective: string;
    tokenBudget?: number;
  }): Promise<AppServerThreadGoalState | undefined> {
    const thread = await this.startThread();
    try {
      const goal = await this.appServer.setThreadGoal({
        threadId: thread.threadId,
        objective: input.objective,
        tokenBudget: input.tokenBudget,
      });
      return goal;
    } catch {
      return undefined;
    }
  }

  snapshot(): ScoutAgentSnapshot {
    return {
      agentId: this.agentId,
      thread: this.thread,
      activeTask: this.taskSnapshot(),
      pendingMessageCount: this.pendingMessages.length,
    };
  }

  private async checkThread(thread: AgentThreadSnapshot): Promise<void> {
    if (this.threadPreflightPromise) return this.threadPreflightPromise;
    this.threadPreflightPromise = runThreadPreflight({
      agentId: this.agentId,
      thread,
      mount: this.agentMount,
    })
      .then((threadPreflight) => {
        if (this.thread?.threadId === thread.threadId) this.threadPreflight = threadPreflight;
      })
      .catch(() => undefined);
    return this.threadPreflightPromise;
  }

  private nextInvocationId(threadId: string): string {
    this.invocationSequence += 1;
    return `${safePathSegment(this.agentId)}-${safePathSegment(threadId)}-invocation-${String(this.invocationSequence).padStart(4, "0")}`;
  }
}

function safePathSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function isTerminalTurnStatus(status: string | undefined): boolean {
  return status === "completed"
    || status === "failed"
    || status === "interrupted"
    || status === "cancelled";
}

function formatTurnError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sameAgentMessage(left: AgentMessage, right: AgentMessage): boolean {
  return left.agentId === right.agentId
    && left.taskId === right.taskId
    && left.body === right.body
    && left.queuedAt === right.queuedAt
    && left.deliveryMode === right.deliveryMode;
}

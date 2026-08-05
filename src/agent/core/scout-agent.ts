import type {
  AppServerPlanState,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import type { CodexAppServerClient } from "../../agent-server/codex/app-server-client.js";
import type { AssetCommit, CodexMount } from "../../asset-store/types.js";
import type { Result } from "../../core/result.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import { AgentRunner } from "../runner/types.js";
import type {
  AgentTaskStepToolCall,
  AgentTaskState,
  SendAgentMessageInput,
} from "../task/types.js";
import type {
  AgentThreadSnapshot,
  AgentThreadSpec,
} from "../thread/types.js";
import {
  runThreadPreflight,
  type ScoutAgentThreadPreflightSnapshot,
} from "../thread/thread-preflight.js";
import { AgentEvents } from "../events/index.js";

export interface ScoutAgentTurnInput {
  prompt: string;
  outputContract?: string;
  timeoutMs?: number;
  sandbox?: "readOnly" | "workspaceWrite";
  writableRoots?: string[];
  onStatusMessage?: (message: string) => void;
  onTurnStarted?(invocationId: string): void | Promise<void>;
}

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

export interface ScoutAgentTurnOutcome {
  turn: ScoutAgentTurnRecord;
  finalResponse?: string;
  toolCalls?: AgentTaskStepToolCall[];
  plan?: AppServerPlanState;
  goal?: AppServerThreadGoalState;
}

export interface ScoutAgentSnapshot {
  agentId: string;
  thread?: AgentThreadSnapshot;
  activeTask?: AgentTaskState;
  pendingMessageCount: number;
}

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
  runner?: AgentRunner;
  private thread?: AgentThreadSnapshot;
  private threadPreflight?: ScoutAgentThreadPreflightSnapshot;
  private threadPreflightPromise?: Promise<void>;
  private invocationSequence = 0;
  private inFlightTurn?: InFlightTurnOwnership;
  private stopping = false;
  private stopPromise?: Promise<void>;

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

  async startThread(): Promise<AgentThreadSnapshot> {
    if (this.thread?.status === "active") return this.thread;
    if (this.thread) {
      throw new Error(`Agent ${this.agentId} thread is closed.`);
    }
    const started = await this.appServer.startThread({
      model: this.spec.model.id,
      modelProvider: this.spec.model.provider,
      reasoningEffort: this.spec.model.reasoningEffort,
      cwd: this.spec.cwd,
      approvalPolicy: this.spec.approvalPolicy,
      sandbox: this.spec.sandbox,
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
    this.eventBus.publish(AgentEvents.thread.started, structuredClone(this.thread));
    await this.checkThread(this.thread);
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
      sandbox: this.spec.sandbox,
      config: this.spec.config,
      baseInstructions: this.spec.baseInstructions,
      developerInstructions: this.spec.developerInstructions,
    });
    await this.appServer.updateThreadSettings({
      threadId: input.thread.threadId,
      cwd: this.spec.cwd,
      approvalPolicy: this.spec.approvalPolicy,
      sandboxPolicy: this.spec.sandbox === "read-only"
        ? {
          type: "readOnly",
          networkAccess: false,
        }
        : {
          type: "workspaceWrite",
          writableRoots: this.defaultWritableRoots(),
          networkAccess: false,
        },
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
    // Calling runner.stop() synchronously seals the loop before the current turn can roll over.
    const runnerStop = this.stopRunner(reason);
    void runnerStop.catch(() => undefined);
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
          runnerStop,
          AGENT_STOP_TIMEOUT_MS,
          `Timed out stopping the runner for agent ${this.agentId}.`,
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

  private async stopRunner(reason: string): Promise<void> {
    await this.runner?.stop(reason);
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
        sandbox: input.sandbox,
        writableRoots: input.writableRoots ?? this.defaultWritableRoots(),
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
      toolCalls: extractToolCalls(result.progressItems ?? []),
      plan: result.plan,
      goal: result.goal,
    };
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
    const taskSnapshot = this.runner?.snapshot() ?? {
      pendingMessageCount: 0,
    };
    return {
      agentId: this.agentId,
      thread: this.thread,
      ...taskSnapshot,
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

  private defaultWritableRoots(): string[] {
    return [...new Set([
      ...this.agentMount.writableRoots,
      this.agentMount.artifactRoot,
    ])];
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

function extractToolCalls(progressItems: NonNullable<Awaited<ReturnType<CodexAppServerClient["runTurn"]>>["progressItems"]>): AgentTaskStepToolCall[] {
  return progressItems.flatMap((progressItem) => {
    const item = progressItem.item;
    if (item.type === "dynamicToolCall") {
      const raw = item as unknown as Record<string, unknown>;
      return [{
        namespace: readOptionalString(raw, "namespace") ?? null,
        tool: item.tool,
        callId: readOptionalString(raw, "callId") ?? item.id,
        arguments: item.arguments,
        success: item.success ?? null,
      }];
    }
    if (item.type === "mcpToolCall") {
      return [{
        namespace: item.server,
        tool: item.tool,
        callId: item.id,
        arguments: item.arguments,
        success: item.status === "completed" ? true : item.status === "failed" ? false : null,
      }];
    }
    return [];
  });
}

function readOptionalString(object: Record<string, unknown>, key: string): string | undefined {
  return typeof object[key] === "string" ? object[key] : undefined;
}

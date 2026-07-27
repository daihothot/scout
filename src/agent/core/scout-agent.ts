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
  status: "completed" | "failed";
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
      model: this.spec.model.id,
      modelProvider: this.spec.model.provider,
      reasoningEffort: this.spec.model.reasoningEffort,
      cwd: this.spec.cwd,
      approvalPolicy: this.spec.approvalPolicy,
      sandbox: this.spec.sandbox,
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
    try {
      await this.runner?.stop(reason);
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

  async runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome> {
    const thread = this.thread;
    if (!thread || thread.status !== "active") {
      throw new Error(`Agent ${this.agentId} thread is not active.`);
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
      });
    } catch (error) {
      const turn: ScoutAgentTurnRecord = {
        invocationId,
        agentId: this.agentId,
        role: this.spec.role,
        threadId: thread.threadId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
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

    const turn: ScoutAgentTurnRecord = {
      invocationId,
      agentId: this.agentId,
      role: this.spec.role,
      threadId: thread.threadId,
      turnId: result.turnId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "completed",
      outputContract: input.outputContract,
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

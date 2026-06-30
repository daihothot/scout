import { CodexAppServerClient } from "../../agent-server/codex/app-server-client.js";
import type {
  AppServerPlanState,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import type { AssetCommit, CodexMount } from "../../asset-store/types.js";
import type { EventBus } from "../../core/events/index.js";
import type { Logger } from "../../core/logging/index.js";
import type { RunContextBundle } from "../../run/types.js";
import {
  ScoutAgentTaskRuntime,
} from "../task/agent-task-runtime.js";
import type { AgentTaskStore } from "../task/agent-task-store.js";
import type {
  AgentTaskStepToolCall,
  AgentTaskState,
} from "../task/types.js";
import type { AgentThreadRecord, AgentThreadSpec } from "../model/types.js";
import type { ScoutAgentThreadPreflightRecord } from "../lifecycle/thread-preflight.js";

export interface ScoutAgentTurnInput {
  prompt: string;
  outputContract?: string;
  timeoutMs?: number;
  sandbox?: "readOnly" | "workspaceWrite";
  writableRoots?: string[];
  collaborationModeId?: string;
  onStatusMessage?: (message: string) => void;
}

export interface ScoutAgentTurnLog {
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
  turn: ScoutAgentTurnLog;
  finalResponse?: string;
  toolCalls?: AgentTaskStepToolCall[];
  plan?: AppServerPlanState;
  goal?: AppServerThreadGoalState;
}

export interface ScoutAgentSnapshot {
  agentId: string;
  thread?: AgentThreadRecord;
  tasks: AgentTaskState[];
  activeTaskId?: string;
  pendingMessageCount: number;
}

export interface ScoutAgentOptions {
  agentId?: string;
  repoRoot: string;
  appServer: CodexAppServerClient;
  contextBundle: RunContextBundle;
  agentMount: CodexMount;
  assetCommit: AssetCommit;
  logger: Logger;
  taskStore: AgentTaskStore;
  eventBus: EventBus;
  dynamicTools?: AgentThreadSpec["dynamicTools"];
}

export class ScoutAgent {
  readonly agentId: string;
  readonly spec: AgentThreadSpec;
  protected readonly appServer: CodexAppServerClient;
  protected readonly contextBundle: RunContextBundle;
  protected readonly agentMount: CodexMount;
  protected readonly assetCommit: AssetCommit;
  protected readonly logger: Logger;
  protected readonly eventBus: EventBus;
  readonly task: ScoutAgentTaskRuntime;
  private thread?: AgentThreadRecord;
  private threadPreflightRunner?: (agent: ScoutAgent) => Promise<{
    thread: AgentThreadRecord;
    preflight: ScoutAgentThreadPreflightRecord;
  }>;
  private invocationSequence = 0;

  constructor(input: ScoutAgentOptions & {
    spec: AgentThreadSpec;
  }) {
    this.agentId = input.agentId ?? input.spec.role;
    this.spec = input.spec;
    this.appServer = input.appServer;
    this.contextBundle = input.contextBundle;
    this.agentMount = input.agentMount;
    this.assetCommit = input.assetCommit;
    this.logger = input.logger;
    this.eventBus = input.eventBus;
    this.logger.registerAgentLogRoot(this.agentId, input.agentMount.logsRoot);

    const agent = this;
    this.task = new ScoutAgentTaskRuntime({
      store: input.taskStore,
      eventBus: this.eventBus,
      host: {
        get agentId() {
          return agent.agentId;
        },
        get role() {
          return agent.role;
        },
        get spec() {
          return agent.spec;
        },
        get threadRecord() {
          return agent.threadRecord;
        },
        logger: this.logger,
        startWithPreflight: () => agent.startWithPreflight(),
        runTurn: (turnInput) => agent.runTurn(turnInput),
        setGoal: (goalInput) => agent.setGoal(goalInput),
      },
    });
  }

  get role(): AgentThreadSpec["role"] {
    return this.spec.role;
  }

  get phases(): AgentThreadSpec["phases"] {
    return this.spec.phases;
  }

  get threadRecord(): AgentThreadRecord | undefined {
    return this.thread;
  }

  get threadId(): string | undefined {
    return this.thread?.threadId;
  }

  get mount(): CodexMount {
    return this.agentMount;
  }

  setThreadPreflightRunner(runner: (agent: ScoutAgent) => Promise<{
    thread: AgentThreadRecord;
    preflight: ScoutAgentThreadPreflightRecord;
  }>): void {
    this.threadPreflightRunner = runner;
  }

  async start(): Promise<AgentThreadRecord> {
    if (this.thread) return this.thread;
    const started = await this.appServer.startThread({
      model: "gpt-5.4-mini",
      modelProvider: "GuruOpenAI",
      cwd: this.spec.cwd,
      approvalPolicy: this.spec.approvalPolicy,
      sandbox: this.spec.sandbox,
      config: this.spec.config ?? {
        model_reasoning_effort: "minimal",
      },
      baseInstructions: this.spec.baseInstructions,
      developerInstructions: this.spec.developerInstructions,
      dynamicTools: this.spec.dynamicTools,
    });
    this.thread = {
      role: this.spec.role,
      phases: this.spec.phases,
      threadId: started.threadId,
      request: this.spec,
      effective: readEffectiveThreadConfig(started.response),
      response: started.response,
    };
    return this.thread;
  }

  async startWithPreflight(): Promise<{
    thread: AgentThreadRecord;
    preflight: ScoutAgentThreadPreflightRecord;
  }> {
    if (!this.threadPreflightRunner) {
      throw new Error(`Agent ${this.agentId} has no thread preflight runner.`);
    }
    return this.threadPreflightRunner(this);
  }

  async runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome> {
    const thread = await this.start();
    const invocationId = this.nextInvocationId(thread.threadId);
    const startedAt = new Date().toISOString();

    this.logger.debug({
      module: "agent",
      event: "turn_started",
      agentId: this.agentId,
      data: {
        invocationId,
        role: thread.role,
        threadId: thread.threadId,
        prompt: input.prompt,
        outputContract: input.outputContract,
      },
    });

    try {
      const result = await this.appServer.runTurn({
        threadId: thread.threadId,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
        sandbox: input.sandbox,
        collaborationModeId: input.collaborationModeId,
        writableRoots: input.writableRoots ?? this.defaultWritableRoots(),
        onStatusMessage: input.onStatusMessage,
      });
      this.logger.debug({
        module: "agent",
        event: "turn_event_snapshot",
        agentId: this.agentId,
        data: {
          invocationId,
          role: thread.role,
          threadId: thread.threadId,
          turnId: result.turnId,
          tokenUsage: result.eventStoreSnapshot?.threads[thread.threadId]?.tokenUsage,
          pendingRequestCount: Object.keys(result.eventStoreSnapshot?.pendingRequests ?? {}).length,
          appServerEventSeq: result.eventStoreSnapshot?.currentSeq ?? 0,
          droppedTimelineCount: result.eventStoreSnapshot?.droppedTimelineCount ?? 0,
        },
      });
      const turn: ScoutAgentTurnLog = {
        invocationId,
        agentId: this.agentId,
        role: thread.role,
        threadId: thread.threadId,
        turnId: result.turnId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "completed",
        outputContract: input.outputContract,
      };
      this.logger.info({
        module: "agent",
        event: "turn_completed",
        agentId: this.agentId,
        data: {
          ...turn,
          finalResponse: result.finalResponse,
        },
      });
      return {
        turn,
        finalResponse: result.finalResponse,
        toolCalls: extractToolCalls(result.progressItems ?? []),
        plan: result.plan,
        goal: result.goal,
      };
    } catch (error) {
      const turn: ScoutAgentTurnLog = {
        invocationId,
        agentId: this.agentId,
        role: thread.role,
        threadId: thread.threadId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        outputContract: input.outputContract,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      };
      this.logger.error({
        module: "agent",
        event: "turn_failed",
        agentId: this.agentId,
        data: turn,
      });
      return { turn };
    }
  }

  async setGoal(input: {
    objective: string;
    tokenBudget?: number;
  }): Promise<AppServerThreadGoalState | undefined> {
    const thread = await this.start();
    try {
      const goal = await this.appServer.setThreadGoal({
        threadId: thread.threadId,
        objective: input.objective,
        tokenBudget: input.tokenBudget,
      });
      return goal;
    } catch (error) {
      this.logger.warn({
        module: "agent",
        event: "thread_goal_set_failed",
        agentId: this.agentId,
        data: {
          threadId: thread.threadId,
          objective: input.objective,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
      });
      return undefined;
    }
  }

  snapshot(): ScoutAgentSnapshot {
    const taskSnapshot = this.task.snapshot();
    return {
      agentId: this.agentId,
      thread: this.thread,
      ...taskSnapshot,
    };
  }

  private defaultWritableRoots(): string[] {
    return [
      this.spec.cwd,
      this.agentMount.artifactRoot,
      ...this.agentMount.writableRoots,
    ];
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

function readEffectiveThreadConfig(response: unknown): AgentThreadRecord["effective"] {
  const root = readObject(response);
  const sandbox = readObjectOrUndefined(root.sandbox);
  return {
    approvalPolicy: readOptionalString(root, "approvalPolicy"),
    sandboxType: sandbox ? readOptionalString(sandbox, "type") : undefined,
    sandboxNetworkAccess: sandbox ? readOptionalBoolean(sandbox, "networkAccess") : undefined,
    reasoningEffort: readOptionalString(root, "reasoningEffort"),
    cwd: readOptionalString(root, "cwd"),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("Expected object.");
  }
  return value;
}

function readObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function readOptionalString(object: Record<string, unknown>, key: string): string | undefined {
  return typeof object[key] === "string" ? object[key] : undefined;
}

function readOptionalBoolean(object: Record<string, unknown>, key: string): boolean | undefined {
  return typeof object[key] === "boolean" ? object[key] : undefined;
}

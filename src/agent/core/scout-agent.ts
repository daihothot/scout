import { CodexAppServerClient } from "../../agent-server/codex/app-server-client.js";
import type {
  AppServerPlanState,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import type { AssetCommit, CodexMount } from "../../asset-store/types.js";
import type { EventBus } from "../../core/events/index.js";
import type { Logger } from "../../core/logging/index.js";
import type { RunContextBundle } from "../../run/types.js";
import { AgentRunner } from "../runner/types.js";
import type { AgentTaskStore } from "../task/agent-task-store.js";
import type {
  AgentTaskStepToolCall,
  AgentTaskState,
} from "../task/types.js";
import type { AgentThreadSnapshot, AgentThreadSpec } from "../thread/types.js";
import { runThreadPreflight } from "../thread/thread-preflight.js";
import type { AgentRegistry } from "./agent-registry.js";

export interface ScoutAgentTurnInput {
  prompt: string;
  outputContract?: string;
  timeoutMs?: number;
  sandbox?: "readOnly" | "workspaceWrite";
  writableRoots?: string[];
  onStatusMessage?: (message: string) => void;
}

export interface ScoutAgentTurnResult {
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
  turn: ScoutAgentTurnResult;
  finalResponse?: string;
  toolCalls?: AgentTaskStepToolCall[];
  plan?: AppServerPlanState;
  goal?: AppServerThreadGoalState;
}

export interface ScoutAgentSnapshot {
  agentId: string;
  thread?: AgentThreadSnapshot;
  tasks: AgentTaskState[];
  activeTask?: AgentTaskState;
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
  registry: AgentRegistry;
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
  protected readonly registry: AgentRegistry;
  runner!: AgentRunner;
  private thread?: AgentThreadSnapshot;
  private threadPreflightPromise?: Promise<void>;
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
    this.registry = input.registry;
    this.logger.registerAgentLogRoot(this.agentId, input.agentMount.logsRoot);
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

  get mount(): CodexMount {
    return this.agentMount;
  }

  async start(): Promise<AgentThreadSnapshot> {
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
      threadId: started.threadId,
      spec: this.spec,
      response: started.response,
    };
    this.registry.bindThread(this.agentId, this.thread.threadId);
    await this.checkThread(this.thread);
    return this.thread;
  }

  async runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome> {
    const thread = this.thread;
    if (!thread) {
      throw new Error(`Agent ${this.agentId} thread is not started.`);
    }
    const invocationId = this.nextInvocationId(thread.threadId);
    const startedAt = new Date().toISOString();

    this.logger.debug({
      module: "agent",
      event: "turn_started",
      agentId: this.agentId,
        data: {
          invocationId,
          role: thread.spec.role,
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
        writableRoots: input.writableRoots ?? this.defaultWritableRoots(),
        onStatusMessage: input.onStatusMessage,
      });
      this.logger.debug({
        module: "agent",
        event: "turn_event_snapshot",
        agentId: this.agentId,
        data: {
          invocationId,
          role: thread.spec.role,
          threadId: thread.threadId,
          turnId: result.turnId,
          tokenUsage: result.eventStoreSnapshot?.threads[thread.threadId]?.tokenUsage,
          pendingRequestCount: Object.keys(result.eventStoreSnapshot?.pendingRequests ?? {}).length,
          appServerEventSeq: result.eventStoreSnapshot?.currentSeq ?? 0,
          droppedTimelineCount: result.eventStoreSnapshot?.droppedTimelineCount ?? 0,
        },
      });
      const turn: ScoutAgentTurnResult = {
        invocationId,
        agentId: this.agentId,
        role: thread.spec.role,
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
      const turn: ScoutAgentTurnResult = {
        invocationId,
        agentId: this.agentId,
        role: thread.spec.role,
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
    const taskSnapshot = this.runner.snapshot();
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
      appServer: this.appServer,
    })
      .then((threadPreflight) => {
        if (this.thread?.threadId === thread.threadId) {
          this.thread = {
            ...this.thread,
            threadPreflight,
          };
        }
        this.logger.info({
          module: "agent.thread",
          event: "thread_preflight_completed",
          agentId: this.agentId,
          data: {
            threadId: thread.threadId,
            status: threadPreflight.result.status,
          },
        });
      })
      .catch((error) => {
        this.logger.error({
          module: "agent.thread",
          event: "thread_preflight_failed",
          agentId: this.agentId,
          data: {
            threadId: thread.threadId,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
          },
        });
      });
    return this.threadPreflightPromise;
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

function readOptionalString(object: Record<string, unknown>, key: string): string | undefined {
  return typeof object[key] === "string" ? object[key] : undefined;
}

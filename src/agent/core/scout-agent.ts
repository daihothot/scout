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
  turnSilenceWarningMs?: number;
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
  private readonly turnSilenceWarningMs: number;
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
    this.turnSilenceWarningMs = input.turnSilenceWarningMs ?? readTurnSilenceWarningMs();
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
      model: this.spec.model.id,
      modelProvider: this.spec.model.provider,
      reasoningEffort: this.spec.model.reasoningEffort,
      cwd: this.spec.cwd,
      approvalPolicy: this.spec.approvalPolicy,
      sandbox: this.spec.sandbox,
      config: this.spec.config,
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
    const startedAtMs = Date.now();
    const prompt = textPreview(input.prompt);

    this.logger.debug({
      module: "agent",
      event: "turn_started",
      agentId: this.agentId,
      data: {
        invocationId,
        role: thread.spec.role,
        threadId: thread.threadId,
        prompt,
        outputContract: input.outputContract,
      },
    });
    const silenceMonitor = new TurnSilenceMonitor({
      appServer: this.appServer,
      threadId: thread.threadId,
      warningMs: this.turnSilenceWarningMs,
      onWarning: (warning) => {
        this.logger.warn({
          module: "agent.turn",
          event: "turn_silence_warning",
          agentId: this.agentId,
          data: {
            invocationId,
            role: thread.spec.role,
            threadId: thread.threadId,
            ...warning,
          },
        });
      },
    });
    silenceMonitor.start();

    try {
      const result = await this.appServer.runTurn({
        threadId: thread.threadId,
        prompt: input.prompt,
        model: thread.spec.model.id,
        reasoningEffort: thread.spec.model.reasoningEffort,
        reasoningSummary: thread.spec.model.reasoningSummary,
        timeoutMs: input.timeoutMs,
        sandbox: input.sandbox,
        writableRoots: input.writableRoots ?? this.defaultWritableRoots(),
        onStatusMessage: input.onStatusMessage,
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
          invocationId,
          role: thread.spec.role,
          threadId: thread.threadId,
          turnId: result.turnId,
          durationMs: Math.max(0, Date.now() - startedAtMs),
          prompt,
          response: textPreview(result.finalResponse ?? ""),
          outputContract: input.outputContract,
          tokenUsage: result.eventStoreSnapshot?.threads[thread.threadId]?.tokenUsage,
          pendingRequestCount: Object.keys(result.eventStoreSnapshot?.pendingRequests ?? {}).length,
          droppedTimelineCount: result.eventStoreSnapshot?.droppedTimelineCount ?? 0,
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
        data: {
          invocationId,
          role: thread.spec.role,
          threadId: thread.threadId,
          durationMs: Math.max(0, Date.now() - startedAtMs),
          prompt,
          outputContract: input.outputContract,
          error: turn.error,
        },
      });
      return { turn };
    } finally {
      silenceMonitor.stop();
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
          objective: textPreview(input.objective),
          error: error instanceof Error ? error.message : String(error),
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

interface TurnSilenceWarning {
  turnId?: string;
  warningCount: number;
  silentForMs: number;
  thresholdMs: number;
  lastActivityAt: string;
}

class TurnSilenceMonitor {
  private readonly appServer: CodexAppServerClient;
  private readonly threadId: string;
  private readonly warningMs: number;
  private readonly onWarning: (warning: TurnSilenceWarning) => void;
  private lastActivityMs = Date.now();
  private warningCount = 0;
  private turnId?: string;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;

  constructor(input: {
    appServer: CodexAppServerClient;
    threadId: string;
    warningMs: number;
    onWarning: (warning: TurnSilenceWarning) => void;
  }) {
    this.appServer = input.appServer;
    this.threadId = input.threadId;
    this.warningMs = input.warningMs;
    this.onWarning = input.onWarning;
  }

  start(): void {
    if (this.warningMs <= 0 || this.timer) return;
    this.lastActivityMs = Date.now();
    this.unsubscribe = this.appServer.onTimeline((entry) => {
      if (entry.threadId !== this.threadId) return;
      this.lastActivityMs = Date.now();
      this.warningCount = 0;
      this.turnId = entry.turnId ?? this.turnId;
    });
    this.timer = setInterval(() => this.check(), this.warningMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private check(): void {
    const now = Date.now();
    const silentForMs = now - this.lastActivityMs;
    const expectedWarningCount = Math.floor(silentForMs / this.warningMs);
    if (expectedWarningCount <= this.warningCount) return;
    this.warningCount = expectedWarningCount;
    this.onWarning({
      turnId: this.turnId,
      warningCount: this.warningCount,
      silentForMs,
      thresholdMs: this.warningMs,
      lastActivityAt: new Date(this.lastActivityMs).toISOString(),
    });
  }
}

function readTurnSilenceWarningMs(): number {
  const configured = Number(process.env.SCOUT_TURN_SILENCE_WARNING_MS ?? 60_000);
  return Number.isFinite(configured) && configured >= 0 ? configured : 60_000;
}

function textPreview(value: string, maxChars = 400): {
  chars: number;
  preview: string;
  truncated: boolean;
} {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return {
    chars: value.length,
    preview: compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact,
    truncated: compact.length > maxChars,
  };
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

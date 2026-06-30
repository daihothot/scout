import type { RuntimeInteractionPort } from "../../interaction/index.js";
import {
  readUserInputRequestId,
  renderHumanInputPrompt,
  renderCoordinatorEvents,
  renderUserInputResponse,
} from "../../interaction/protocol/index.js";
import {
  SystemEvents,
  type EventBus,
  type ScoutEvent,
  type UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { AgenticLoop } from "../core/agentic-loop.js";
import { AgentBackend } from "../backend/agent-backend.js";
import { CoordinatorAgent } from "../roles/coordinator-agent.js";
import type { ScoutAgentTurnLog } from "../core/scout-agent.js";
import type {
  AgentTaskSystemEvent,
  SystemInterruptEventPayload,
} from "../task/task-events.js";
import type {
  CoordinatorPromptReadyPayload,
  SystemOrchestrationEvent,
} from "./orchestration-events.js";

export interface AgentOrchestratorOptions {
  coordinator: CoordinatorAgent;
  agentBackend: AgentBackend;
  eventBus: EventBus;
  maxSteps?: number;
  idlePollMs?: number;
  interactionPort?: RuntimeInteractionPort;
}

export interface AgentOrchestratorResult {
  status: "completed" | "blocked" | "failed" | "idle" | "max_steps";
  steps: number;
  coordinatorThreadId: string;
  lastTurn?: ScoutAgentTurnLog;
}

export class AgentOrchestrator {
  private readonly coordinator: CoordinatorAgent;
  private readonly agentBackend: AgentBackend;
  private readonly eventBus: EventBus;
  private readonly maxSteps: number;
  private readonly idlePollMs: number;
  private readonly interactionPort?: RuntimeInteractionPort;
  private readonly eventInbox: OrchestrationInboxEvent[] = [];
  private readonly unsubscribeHandlers: UnsubscribeEventHandler[] = [];
  private steps = 0;
  private stopped = false;
  private promptQueue: string[] = [];
  private lastTurn?: ScoutAgentTurnLog;
  private terminalStatus?: AgentOrchestratorResult["status"];

  constructor(options: AgentOrchestratorOptions) {
    this.coordinator = options.coordinator;
    this.agentBackend = options.agentBackend;
    this.eventBus = options.eventBus;
    this.maxSteps = options.maxSteps ?? 12;
    this.idlePollMs = options.idlePollMs ?? 500;
    this.interactionPort = options.interactionPort;
    this.subscribeToEvents();
  }

  async run(): Promise<AgentOrchestratorResult> {
    const coordinatorThreadId = this.requireCoordinatorThreadId();
    await this.interactionPort?.disclose({
      level: "info",
      source: "agent.orchestrator",
      message: "Coordinator 主循环已启动。",
      data: {
        coordinatorThreadId,
        maxSteps: this.maxSteps,
      },
    });
    const loop = new AgenticLoop({
      agentId: coordinatorThreadId,
      handlers: {
        runStep: () => this.runStep(),
        hasPendingWork: () => this.hasPendingWork(),
        isStopped: () => this.stopped,
        onError: (error) => this.stopWithError(error),
      },
    });
    try {
      await loop.runToIdle();
    } finally {
      this.unsubscribeFromEvents();
    }
    const result = {
      status: this.terminalStatus ?? "idle",
      steps: this.steps,
      coordinatorThreadId,
      lastTurn: this.lastTurn,
    };
    await this.interactionPort?.disclose({
      level: result.status === "failed" || result.status === "blocked" ? "warn" : "info",
      source: "agent.orchestrator",
      message: "Coordinator 主循环已结束。",
      data: result,
    });
    return result;
  }

  private async runStep(): Promise<void> {
    if (this.steps >= this.maxSteps) {
      this.terminalStatus = "max_steps";
      this.stopped = true;
      return;
    }

    const events = this.drainEventInbox();
    if (events.length > 0) {
      const userInputResponses: string[] = [];
      const eventsForPrompt: AgentTaskSystemEvent[] = [];
      for (const event of events) {
        if (isHumanInputInterruptRaised(event)) {
          eventsForPrompt.push(event);
          await this.interactionPort?.notify(event);
          const response = await this.interactionPort?.requestInput({
            id: event.payload.requestId ?? event.id,
            prompt: renderHumanInputPrompt(event),
            reason: "Agent requested user input while executing a task.",
          });
          if (response) {
            const requestId = readUserInputRequestId(event);
            if (event.payload.taskId && requestId) {
              const task = this.agentBackend.task.handleUserInputResponse({
                taskId: event.payload.taskId,
                requestId,
                response: response.text,
              });
              this.eventBus.publish(SystemEvents.interrupt.resolved, {
                interruptKind: "human_input",
                taskId: task.taskId,
                agentId: task.agentId,
                requestId,
                response: {
                  requestId,
                  agentId: task.agentId,
                  taskId: task.taskId,
                  response: response.text,
                  createdAt: new Date().toISOString(),
                },
                task,
              } satisfies SystemInterruptEventPayload);
            }
            userInputResponses.push(renderUserInputResponse(event, response.text));
          }
          continue;
        }
        if (isCoordinatorPromptReady(event)) {
          for (const sourceEvent of event.payload.sourceEvents) {
            eventsForPrompt.push(sourceEvent);
            await this.interactionPort?.notify(sourceEvent);
          }
        }
      }
      const resolvedEvents = this.drainEventInbox();
      for (const event of resolvedEvents) {
        if (isCoordinatorPromptReady(event)) {
          eventsForPrompt.push(...event.payload.sourceEvents);
          continue;
        }
        if (isHumanInputInterruptRaised(event)) {
          eventsForPrompt.push(event);
        }
      }
      this.promptQueue.push(renderCoordinatorEvents([
        ...eventsForPrompt,
      ]));
      if (userInputResponses.length > 0) {
        this.promptQueue.push([
          "<user-input-responses>",
          ...userInputResponses,
          "</user-input-responses>",
        ].join("\n"));
      }
    }
    if (this.promptQueue.length === 0) {
      if (this.agentBackend.task.hasRunningAgentTasks()) {
        await delay(this.idlePollMs);
        return;
      }
      if (!this.hasQueuedEvents()) {
        this.terminalStatus = "idle";
        this.stopped = true;
      }
      return;
    }

    const prompt = this.promptQueue.join("\n\n");
    this.promptQueue = [];
    this.steps += 1;
    const outcome = await this.coordinator.runTurn({
      prompt,
      sandbox: "workspaceWrite",
      outputContract: "coordinator_main_loop",
    });
    this.lastTurn = outcome.turn;
    this.agentBackend.flushLedger();
    await this.interactionPort?.disclose({
      level: this.lastTurn.status === "failed" ? "error" : "debug",
      source: "agent.orchestrator",
      message: "Coordinator turn completed.",
      data: {
        step: this.steps,
        invocationId: this.lastTurn.invocationId,
        status: this.lastTurn.status,
      },
    });

  }

  private hasPendingWork(): boolean {
    return this.promptQueue.length > 0
      || this.hasQueuedEvents()
      || this.agentBackend.task.hasRunningAgentTasks();
  }

  private subscribeToEvents(): void {
    this.unsubscribeHandlers.push(
      this.eventBus.subscribe(SystemEvents.interrupt, (event) => {
        this.eventInbox.push(event as ScoutEvent<SystemInterruptEventPayload> as AgentTaskSystemEvent);
      }),
      this.eventBus.subscribe(SystemEvents.orchestration, (event) => {
        this.eventInbox.push(event as ScoutEvent<CoordinatorPromptReadyPayload> as SystemOrchestrationEvent);
      }),
    );
  }

  private unsubscribeFromEvents(): void {
    while (this.unsubscribeHandlers.length > 0) {
      this.unsubscribeHandlers.pop()?.();
    }
  }

  private drainEventInbox(): OrchestrationInboxEvent[] {
    return this.eventInbox.splice(0);
  }

  private hasQueuedEvents(): boolean {
    return this.eventInbox.length > 0;
  }

  private stopWithError(error: unknown): void {
    this.terminalStatus = "failed";
    this.stopped = true;
    this.promptQueue = [
      `Coordinator 主循环失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    ];
  }

  private requireCoordinatorThreadId(): string {
    const threadId = this.coordinator.threadId;
    if (!threadId) {
      throw new Error("Coordinator thread has not started.");
    }
    return threadId;
  }
}

type OrchestrationInboxEvent = AgentTaskSystemEvent | SystemOrchestrationEvent;

function isHumanInputInterruptRaised(event: OrchestrationInboxEvent): event is AgentTaskSystemEvent & {
  payload: SystemInterruptEventPayload;
} {
  return SystemEvents.interrupt.raised.is(event)
    && (event.payload as Partial<SystemInterruptEventPayload>).interruptKind === "human_input";
}

function isCoordinatorPromptReady(event: OrchestrationInboxEvent): event is SystemOrchestrationEvent {
  return SystemEvents.orchestration.coordinatorPromptReady.is(event);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

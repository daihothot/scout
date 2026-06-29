import type { AgentThreadRecord } from "../types.js";
import type { RuntimeInteractionPort } from "../../interaction/index.js";
import {
  renderHumanInputPrompt,
  renderQueuedCommands,
  renderUserInputResponse,
} from "../../interaction/protocol/index.js";
import { AgenticLoop } from "./agentic-loop.js";
import type {
  CoordinatorSyntheticOutput,
} from "../backend/agent-backend.js";
import { AgentBackend } from "../backend/agent-backend.js";
import { CoordinatorAgent } from "../roles/coordinator-agent.js";
import type { ScoutAgentTurnLog } from "../scout-agent.js";

export interface ScoutAgentOrchestratorOptions {
  coordinator: CoordinatorAgent;
  agentBackend: AgentBackend;
  coordinatorThread: AgentThreadRecord;
  initialPrompt: string;
  maxSteps?: number;
  idlePollMs?: number;
  interactionPort?: RuntimeInteractionPort;
}

export interface ScoutAgentOrchestratorResult {
  status: "completed" | "blocked" | "failed" | "idle" | "max_steps";
  steps: number;
  coordinatorThreadId: string;
  syntheticOutput?: CoordinatorSyntheticOutput;
  lastTurn?: ScoutAgentTurnLog;
}

export class ScoutAgentOrchestrator {
  private readonly coordinator: CoordinatorAgent;
  private readonly agentBackend: AgentBackend;
  private readonly coordinatorThread: AgentThreadRecord;
  private readonly initialPrompt: string;
  private readonly maxSteps: number;
  private readonly idlePollMs: number;
  private readonly interactionPort?: RuntimeInteractionPort;
  private steps = 0;
  private stopped = false;
  private promptQueue: string[] = [];
  private lastTurn?: ScoutAgentTurnLog;
  private terminalStatus?: ScoutAgentOrchestratorResult["status"];

  constructor(options: ScoutAgentOrchestratorOptions) {
    this.coordinator = options.coordinator;
    this.agentBackend = options.agentBackend;
    this.coordinatorThread = options.coordinatorThread;
    this.initialPrompt = options.initialPrompt;
    this.maxSteps = options.maxSteps ?? 12;
    this.idlePollMs = options.idlePollMs ?? 500;
    this.interactionPort = options.interactionPort;
    this.promptQueue.push(options.initialPrompt);
  }

  async run(): Promise<ScoutAgentOrchestratorResult> {
    await this.interactionPort?.disclose({
      level: "info",
      source: "agent.orchestrator",
      message: "Coordinator 主循环已启动。",
      data: {
        coordinatorThreadId: this.coordinator.threadId,
        maxSteps: this.maxSteps,
      },
    });
    const loop = new AgenticLoop({
      agentId: this.coordinatorThread.threadId,
      handlers: {
        runStep: () => this.runStep(),
        hasPendingWork: () => this.hasPendingWork(),
        isStopped: () => this.stopped,
        onError: (error) => this.stopWithError(error),
      },
    });
    await loop.runToIdle();
    const syntheticOutput = this.agentBackend.tool.getSyntheticOutput();
    const result = {
      status: this.terminalStatus ?? statusFromSyntheticOutput(syntheticOutput) ?? "idle",
      steps: this.steps,
      coordinatorThreadId: this.coordinatorThread.threadId,
      syntheticOutput,
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

    const commands = this.agentBackend.task.drainCoordinatorCommands();
    if (commands.length > 0) {
      const userInputResponses: string[] = [];
      for (const command of commands) {
        await this.interactionPort?.notify(command);
        if (command.type === "user_input") {
          const response = await this.interactionPort?.requestInput({
            id: command.id,
            prompt: renderHumanInputPrompt(command),
            reason: "Agent requested user input while executing a task.",
          });
          if (response) {
            userInputResponses.push(renderUserInputResponse(command, response.text));
          }
        }
      }
      this.promptQueue.push(renderQueuedCommands(commands));
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
      if (!this.agentBackend.task.hasQueuedCoordinatorCommands()) {
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
    this.agentBackend.task.flushLedger();
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

    const syntheticOutput = this.agentBackend.tool.getSyntheticOutput();
    const syntheticStatus = statusFromSyntheticOutput(syntheticOutput);
    if (syntheticStatus && syntheticStatus !== "idle") {
      this.terminalStatus = syntheticStatus;
      this.stopped = true;
    }
  }

  private hasPendingWork(): boolean {
    return this.promptQueue.length > 0
      || this.agentBackend.task.hasQueuedCoordinatorCommands()
      || this.agentBackend.task.hasRunningAgentTasks();
  }

  private stopWithError(error: unknown): void {
    this.terminalStatus = "failed";
    this.stopped = true;
    this.promptQueue = [
      `Coordinator 主循环失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    ];
  }
}

function statusFromSyntheticOutput(output: CoordinatorSyntheticOutput | undefined): ScoutAgentOrchestratorResult["status"] | undefined {
  if (!output) return undefined;
  if (output.status === "complete") return "completed";
  if (output.status === "blocked") return "blocked";
  if (output.status === "failed") return "failed";
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

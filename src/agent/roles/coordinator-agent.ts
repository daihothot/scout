import {
  scoutAgentPermissionProfile,
} from "../thread/types.js";
import {
  ScoutAgent,
  type ScoutAgentOptions,
} from "../core/scout-agent.js";
import { CoordinatorRunner } from "../runner/coordinator/coordinator-runner.js";
import { readAgentInstructions } from "./instructions.js";
import { Result } from "../../core/result.js";
import type { SendAgentMessageInput } from "../task/types.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgenticLoop } from "../core/agentic-loop.js";
import { AgentInbox } from "../core/agent-inbox.js";
import type { AgentMessage } from "../message/types.js";
import type { ScoutEvent } from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/index.js";
import { AgentEvents } from "../events/index.js";
import type { UserMessageSubmittedPayload } from "../../interaction/gateway/interaction-events.js";
import { attachments } from "../context/attachments.js";
import { agent } from "../context/agent-attachments.js";
import { coordinator } from "../runner/coordinator/coordinator-attachments.js";
import { resolveSynthesisRole } from "../../core/workflow/index.js";

interface CoordinatorTick {
  messages: AgentMessage[];
  workflowPhaseRequested: boolean;
}

/** Coordinator role: owns orchestration messages and task assignment, not worker tasks. */
export class CoordinatorAgent extends ScoutAgent {
  readonly stepRunner: CoordinatorRunner;
  private readonly loop: AgenticLoop<CoordinatorTick>;
  private readonly inbox: AgentInbox;
  private resumeContext?: string;
  private workflowPhaseStepRequested = false;

  constructor(options: ScoutAgentOptions) {
    const scope = currentRunScope();
    const role = resolveSynthesisRole(scope.scheduler.snapshot()).name;
    super({
      ...options,
      spec: {
        role,
        phases: [...options.agentMount.agentProfile.phases],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: "never",
        permissionProfile: scoutAgentPermissionProfile(role),
        contextBundleId: scope.contextBundle.contextBundleId,
        model: { ...options.agentMount.agentProfile.model },
        config: {
          web_search: "disabled",
          features: {
            shell_tool: true,
            multi_agent: options.agentMount.agentProfile.multiAgent,
            apps: false,
          },
          agents: {
            max_threads: options.agentMount.agentProfile.maxThreads,
            max_depth: options.agentMount.agentProfile.maxDepth,
          },
        },
        developerInstructions: readAgentInstructions(options),
        dynamicTools: options.dynamicTools,
      },
    });
    const coordinatorAgent = this;
    this.stepRunner = new CoordinatorRunner({
      host: {
        get agentId() {
          return coordinatorAgent.agentId;
        },
        runTurn: (turnInput) => coordinatorAgent.runTurn(turnInput),
      },
    });
    this.loop = new AgenticLoop({
      agentId: this.agentId,
      takeTick: () => this.takeCoordinatorTick(),
      runTick: (messages) => this.runCoordinatorTick(messages),
      isStopped: () => this.isStopping,
      onError: (error) => this.publishFailure(error),
    });
    this.inbox = new AgentInbox({
      isStopped: () => this.isStopping,
      onEvents: (events) => this.handleInboxEvents(events),
      onError: (error) => this.publishFailure(error),
    });
    this.inbox.subscribe<UserMessageSubmittedPayload>(SystemEvents.interaction.userMessageSubmitted);
  }

  async sendMessage(input: SendAgentMessageInput): Promise<Result<void, string>> {
    if (input.taskId) {
      return Result.err(`Coordinator agent ${this.agentId} does not own task ${input.taskId}.`);
    }
    const accepted = await this.enqueueMessageDelivery(input, {
      deliveryName: "Coordinator",
    });
    if (accepted && !this.isStopping) this.loop.schedule();
    return Result.ok(undefined);
  }

  restoreState(input: {
    acceptedMessages: AgentMessage[];
    pendingMessages: AgentMessage[];
    resumeContext: string;
  }): void {
    this.restoreMessageState({
      acceptedMessages: input.acceptedMessages,
      pendingMessages: input.pendingMessages,
      deliveryName: "Coordinator",
    });
    this.resumeContext = input.resumeContext;
  }

  activateRestoredState(): void {
    this.loop.schedule();
  }

  async runToIdle(): Promise<void> {
    await Promise.all([
      this.inbox.runToIdle(),
      this.loop.runToIdle(),
    ]);
  }

  /** Requests a fresh Coordinator Step after Scheduler advances to another Phase. */
  scheduleCurrentPhaseStep(): void {
    this.workflowPhaseStepRequested = true;
    if (!this.isStopping) this.loop.schedule();
  }

  protected async stopExecution(reason: string): Promise<void> {
    this.inbox.stop();
    this.loop.stop();
    await Promise.all([
      this.inbox.runToIdle(),
      this.loop.runToIdle(),
      this.stepRunner.stop(reason),
    ]);
  }

  private takeCoordinatorTick(): CoordinatorTick | undefined {
    if (
      this.pendingMessageCount === 0
      && !this.resumeContext
      && !this.workflowPhaseStepRequested
    ) return undefined;
    return {
      messages: this.pendingMessagesSnapshot(),
      workflowPhaseRequested: this.workflowPhaseStepRequested,
    };
  }

  private async handleInboxEvents(events: ScoutEvent[]): Promise<void> {
    for (const event of events) {
      if (SystemEvents.interaction.userMessageSubmitted.is(event)) {
        const payload = event.payload;
        if (payload.attachment.trim().length > 0) {
          await this.sendMessage({
            message: payload.attachment,
            delivery: {
              messageId: payload.messageId,
              queuedAt: payload.submittedAt,
            },
          });
        }
        continue;
      }
    }
    if (!this.isStopping) this.loop.schedule();
  }

  private async runCoordinatorTick(tick: CoordinatorTick): Promise<void> {
    const { messages } = tick;
    const prompt = attachments.compose(
      agent.turn.workflow_phase(),
      ...(this.resumeContext ? [this.resumeContext] : []),
      ...messages.map((message) => message.body),
    );
    const result = await this.stepRunner.runStep({
      prompt,
      outputContract: "coordinator_main_loop",
      onTurnStarted: (step) => {
        this.consumeQueuedMessages(messages, step.stepId);
        this.resumeContext = undefined;
        if (tick.workflowPhaseRequested) this.workflowPhaseStepRequested = false;
      },
    });
    const { outcome } = result;
    if (outcome.turn.status !== "completed") return;
    const text = outcome.finalResponse?.trim();
    if (!text) return;
    const produced = {
      messageId: `${outcome.turn.invocationId}-message`,
      agentId: this.agentId,
      threadId: outcome.turn.threadId,
      turnId: outcome.turn.turnId,
      text,
      createdAt: outcome.turn.finishedAt,
    };
    this.eventBus.publish(
      AgentEvents.coordinator.messageProduced,
      produced,
      { occurredAt: produced.createdAt },
    );
  }

  private publishFailure(error: unknown): void {
    const produced = {
      messageId: `${this.agentId}-runner-error-${Date.now()}`,
      agentId: this.agentId,
      threadId: this.threadId,
      text: `Coordinator turn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      createdAt: new Date().toISOString(),
      data: {
        level: "error",
      },
    };
    this.eventBus.publish(
      AgentEvents.coordinator.messageProduced,
      produced,
      { occurredAt: produced.createdAt },
    );
  }
}

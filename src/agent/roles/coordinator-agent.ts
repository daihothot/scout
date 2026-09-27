import {
  scoutAgentPermissionProfile,
} from "../thread/types.js";
import {
  ScoutAgent,
  type ScoutAgentOptions,
} from "../core/scout-agent.js";
import { CoordinatorRunner } from "../runner/coordinator/coordinator-runner.js";
import { readCoordinatorAgentInstructions } from "./instructions.js";
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
  flowSettlementRequested: boolean;
}

/** Coordinator role: owns orchestration messages and task assignment, not worker tasks. */
export class CoordinatorAgent extends ScoutAgent {
  readonly stepRunner: CoordinatorRunner;
  private readonly loop: AgenticLoop<CoordinatorTick>;
  private readonly inbox: AgentInbox;
  private resumeContext?: string;
  private workflowPhaseStepRequested = false;
  private flowSettlementRequested = false;
  private readonly userInputs = new Map<string, ScoutEvent<UserMessageSubmittedPayload>>();

  constructor(options: ScoutAgentOptions) {
    const scope = currentRunScope();
    const role = resolveSynthesisRole(scope.workflow.scheduler.snapshot()).name;
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
        developerInstructions: readCoordinatorAgentInstructions(options),
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
      runTick: async (tick) => {
        try {
          await this.runCoordinatorTick(tick);
        } catch (error) {
          // Keep the failed tick's report in its Flow before attempting the
          // independent lifecycle transition.
          this.publishFailure(error);
        }
        if (!this.isStopping) {
          const previousFlowId = scope.workflow.flowSnapshot().flowId;
          await scope.workflow.prepareNextFlow();
          if (scope.workflow.flowSnapshot().flowId !== previousFlowId) {
            this.flowSettlementRequested = false;
            this.workflowPhaseStepRequested = false;
          }
        }
      },
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
    userInputs: ScoutEvent<UserMessageSubmittedPayload>[];
  }): void {
    for (const event of input.userInputs) {
      this.userInputs.set(event.payload.messageId, { ...event, payload: structuredClone(event.payload) });
    }
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

  /** Finishes accepted input delivery without waiting on the Coordinator's own Step. */
  async drainInput(): Promise<void> {
    await this.inbox.runToIdle();
  }

  /** Input owned by this inbox that has not been consumed by any Step. */
  pendingFlowInputs(): Array<{ event: ScoutEvent<UserMessageSubmittedPayload>; delivery: AgentMessage }> {
    return this.pendingMessagesSnapshot().flatMap((delivery) => {
      const event = this.userInputs.get(delivery.messageId);
      return event ? [{ event: { ...event, payload: structuredClone(event.payload) }, delivery }] : [];
    });
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

  /** Schedules a terminal follow-up if automatic Flow settlement cannot finish. */
  scheduleFlowSettlementStep(): void {
    this.flowSettlementRequested = true;
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
    const messages = this.pendingMessagesSnapshot().filter((message) =>
      this.runScope.workflow.flowSnapshot().status === "active" || !this.userInputs.has(message.messageId)
    );
    if (
      messages.length === 0
      && !this.resumeContext
      && !this.workflowPhaseStepRequested
      && !this.flowSettlementRequested
    ) return undefined;
    return {
      messages,
      workflowPhaseRequested: this.workflowPhaseStepRequested,
      flowSettlementRequested: this.flowSettlementRequested,
    };
  }

  private async handleInboxEvents(events: ScoutEvent[]): Promise<void> {
    for (const event of events) {
      if (SystemEvents.interaction.userMessageSubmitted.is(event)) {
        const payload = event.payload;
        if (payload.attachment.trim().length > 0) {
          if (!this.userInputs.has(payload.messageId)) {
            this.userInputs.set(payload.messageId, { ...event, payload: structuredClone(payload) });
          }
          await this.sendMessage({
            message: payload.attachment,
            deliveryMode: "queued",
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
        if (tick.flowSettlementRequested) this.flowSettlementRequested = false;
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

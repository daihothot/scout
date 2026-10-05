import {
  scoutAgentPermissionProfile,
  scoutAgentApprovalPolicy,
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
import type { DynamicToolCallInput } from "../../agent-server/types.js";

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
  private readonly userInputs = new Map<string, ScoutEvent<UserMessageSubmittedPayload>>();
  private pendingWorkflowStart?: { threadId: string; turnId: string; callId: string; name: string };

  constructor(options: ScoutAgentOptions) {
    const scope = currentRunScope();
    const role = resolveSynthesisRole(scope.workflow.graph.snapshot()).name;
    super({
      ...options,
      spec: {
        role,
        phases: [...options.agentMount.agentProfile.phases],
        cwd: options.agentMount.mountRoot,
        approvalPolicy: scoutAgentApprovalPolicy,
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
        let completed = false;
        try {
          completed = await this.runCoordinatorTick(tick);
        } catch (error) {
          this.publishFailure(error);
        }
        const request = this.pendingWorkflowStart;
        this.pendingWorkflowStart = undefined;
        if (!this.isStopping) {
          if (!scope.workflow.snapshot()) {
            this.workflowPhaseStepRequested = false;
          }
          if (request && completed) {
            await scope.workflow.startWorkflow(request.name);
            this.scheduleCurrentPhaseStep();
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

  /** Accepts intent without moving the Workflow boundary inside the caller's Turn. */
  requestWorkflowStart(delivery: DynamicToolCallInput, name: string): void {
    this.assertOwnsActiveTurn(delivery);
    if (this.runScope.workflow.snapshot()) throw new Error("Finish the active Workflow before requesting another.");
    const current = this.pendingWorkflowStart;
    if (current) {
      if (current.threadId === delivery.threadId && current.turnId === delivery.turnId
        && current.callId === delivery.callId && current.name === name) return;
      throw new Error("This Turn already requested a Workflow. End the current Turn.");
    }
    this.pendingWorkflowStart = { threadId: delivery.threadId, turnId: delivery.turnId, callId: delivery.callId, name };
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
  pendingWorkflowInputs(): Array<{ event: ScoutEvent<UserMessageSubmittedPayload>; delivery: AgentMessage }> {
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

  /** Requests a fresh Coordinator Step after Workflow advances to another Phase. */
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
    const messages = this.pendingMessagesSnapshot().filter((message) =>
      this.runScope.workflow.snapshot()?.status !== "settling" || !this.userInputs.has(message.messageId)
    );
    if (
      messages.length === 0
      && !this.resumeContext
      && !this.workflowPhaseStepRequested
    ) return undefined;
    return {
      messages,
      workflowPhaseRequested: this.workflowPhaseStepRequested,
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

  private async runCoordinatorTick(tick: CoordinatorTick): Promise<boolean> {
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
    if (outcome.turn.status !== "completed") return false;
    const text = outcome.finalResponse?.trim();
    if (!text) return true;
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
    return true;
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

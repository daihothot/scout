import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../core/scout-agent.js";
import type {
  EventBus,
  ScoutEvent,
} from "../../core/events/index.js";
import { EventMailbox } from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/index.js";
import { AgenticLoop } from "../core/agentic-loop.js";
import type {
  SystemInterruptEventPayload,
} from "../orchestration/interrupt-events.js";
import type {
  SystemDispatchRequestedPayload,
} from "./runner-events.js";
import type { UserMessageSubmittedPayload } from "../../interaction/gateway/interaction-events.js";
import { AgentRunner } from "./types.js";

export interface CoordinatorRunnerHost {
  readonly agentId: string;
  readonly threadId?: string;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
}

export class CoordinatorRunner extends AgentRunner {
  readonly runnerKind = "coordinator";
  private readonly host: CoordinatorRunnerHost;
  private readonly eventBus: EventBus;
  private readonly mailbox: EventMailbox;
  private readonly loop: AgenticLoop<ScoutEvent[]>;
  private stopped = false;
  private stopReason?: string;

  constructor(options: { host: CoordinatorRunnerHost; eventBus: EventBus }) {
    super();
    this.host = options.host;
    this.eventBus = options.eventBus;
    this.mailbox = new EventMailbox({
      eventBus: this.eventBus,
      onEvent: () => this.loop.schedule(),
    });
    this.loop = new AgenticLoop<ScoutEvent[]>({
      agentId: this.host.agentId,
      handlers: {
        takeStep: () => this.mailbox.takeAll(),
        runStep: (events) => this.runMailboxStep(events),
        isStopped: () => this.stopped,
        onError: (error) => this.publishFailure(error),
      },
    });
    this.mailbox.subscribe<UserMessageSubmittedPayload>(SystemEvents.interaction.userMessageSubmitted);
    this.mailbox.subscribe<SystemDispatchRequestedPayload>(SystemEvents.system.dispatchRequested);
    this.mailbox.subscribe<SystemInterruptEventPayload>(SystemEvents.interrupt);
  }

  get agentId(): string {
    return this.host.agentId;
  }

  stop(reason?: string): void {
    this.stopped = true;
    this.stopReason = reason;
    this.mailbox.stop();
  }

  private async runMailboxStep(events: ScoutEvent[]): Promise<void> {
    const outcome = await this.runFromMailboxEvents(events);
    this.publishOutcome(outcome);
  }

  private async runFromMailboxEvents(events: ScoutEvent[]): Promise<ScoutAgentTurnOutcome> {
    if (this.stopped) {
      throw new Error(`Coordinator runner ${this.agentId} is stopped.${this.stopReason ? ` Reason: ${this.stopReason}` : ""}`);
    }
    return this.host.runTurn({
      prompt: renderCoordinatorMailboxInput({
        messages: events.map(toRunnerInputMessage),
      }),
      sandbox: "workspaceWrite",
      outputContract: "coordinator_main_loop",
    });
  }

  private publishOutcome(outcome: ScoutAgentTurnOutcome): void {
    this.eventBus.publish(SystemEvents.agent.turnCompleted, {
      agentId: this.agentId,
      threadId: outcome.turn.threadId,
      turnId: outcome.turn.turnId,
      status: outcome.turn.status,
      completedAt: outcome.turn.finishedAt,
      turn: outcome.turn,
    });
    const text = outcome.finalResponse?.trim();
    if (!text) return;
    this.eventBus.publish(SystemEvents.agent.messageProduced, {
      messageId: `${outcome.turn.invocationId}-message`,
      agentId: this.agentId,
      threadId: outcome.turn.threadId,
      turnId: outcome.turn.turnId,
      text,
      createdAt: outcome.turn.finishedAt,
    });
  }

  private publishFailure(error: unknown): void {
    this.eventBus.publish(SystemEvents.agent.messageProduced, {
      messageId: `${this.agentId}-runner-error-${Date.now()}`,
      agentId: this.agentId,
      threadId: this.host.threadId,
      text: `Coordinator turn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      createdAt: new Date().toISOString(),
      data: {
        level: "error",
      },
    });
  }
}

function toRunnerInputMessage(event: ScoutEvent): RunnerInputMessage {
  if (SystemEvents.interaction.userMessageSubmitted.is(event as ScoutEvent)) {
    return {
      type: "user_message",
      message: event.payload as UserMessageSubmittedPayload,
    };
  }
  if (SystemEvents.interrupt.is(event)) {
    return {
      type: "interrupt",
      interrupt: event as ScoutEvent<SystemInterruptEventPayload>,
    };
  }
  return {
    type: "system_dispatch",
    dispatch: event.payload as SystemDispatchRequestedPayload,
  };
}

type RunnerInputMessage =
  | {
    type: "user_message";
    message: UserMessageSubmittedPayload;
  }
  | {
    type: "system_dispatch";
    dispatch: SystemDispatchRequestedPayload;
  }
  | {
    type: "interrupt";
    interrupt: ScoutEvent<SystemInterruptEventPayload>;
  };

function renderCoordinatorMailboxInput(input: { messages: RunnerInputMessage[] }): string {
  return JSON.stringify({
    type: "coordinator_messages",
    messages: input.messages.map((message) => {
      if (message.type === "user_message") {
        return {
          type: message.type,
          message: message.message,
        };
      }
      if (message.type === "system_dispatch") {
        return {
          type: message.type,
          dispatch: summarizeSystemDispatch(message.dispatch),
        };
      }
      return {
        type: message.type,
        interrupt: summarizeInterrupt(message.interrupt),
      };
    }),
  }, null, 2);
}

function summarizeSystemDispatch(dispatch: SystemDispatchRequestedPayload): unknown {
  return {
    dispatchId: dispatch.dispatchId,
    reason: dispatch.reason,
    systemMessage: dispatch.systemMessage,
    createdAt: dispatch.createdAt,
    data: dispatch.data,
  };
}

function summarizeInterrupt(event: ScoutEvent<SystemInterruptEventPayload>): unknown {
  return {
    id: event.id,
    key: event.key.routeKey,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
}

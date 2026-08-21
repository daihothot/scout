import { randomUUID } from "node:crypto";
import { AgentEvents } from "../events/index.js";
import type { AgentMessage } from "../message/types.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import type { AgentHumanInputState } from "../human-input/agent-human-input-store.js";
import type { RunScope } from "../../run/run-scope.js";
import { currentRunScope } from "../../run/run-scope.js";
import { agent } from "../context/agent-attachments.js";
import { attachments } from "../context/attachments.js";
import { ScoutAgentRoles } from "../thread/types.js";

export interface AgentHumanInputRequestResult {
  status: "accepted" | "queued";
  taskId: string;
  agentId: string;
  requestId: string;
  created: boolean;
  message?: AgentMessage;
}

export interface AgentHumanInputResponseTarget {
  requestId: string;
  response?: AgentHumanInputState["response"];
}

/** Owns Human Input facts, request lookup, and delivery independent of Task disposition policy. */
export class AgentHumanInputBackend {
  private readonly eventBus: RunScope["eventBus"];
  private readonly registry: RunScope["agentRegistry"];
  private readonly humanInputStore: RunScope["humanInputStore"];

  constructor() {
    const scope = currentRunScope();
    this.eventBus = scope.eventBus;
    this.registry = scope.agentRegistry;
    this.humanInputStore = scope.humanInputStore;
  }

  listForTask(taskId: string): AgentHumanInputState[] {
    return this.humanInputStore.listForTask(taskId);
  }

  findRequest(taskId: string, requestId: string): AgentHumanInputState | undefined {
    return this.listForTask(taskId).find((request) => request.requestId === requestId);
  }

  findUnresolvedRequests(taskId: string): AgentHumanInputState[] {
    return this.listForTask(taskId).filter((request) => !request.response);
  }

  findResponseByBody(taskId: string, body: string): AgentHumanInputState | undefined {
    return this.listForTask(taskId).find((request) => request.response?.body === body);
  }

  async request(input: {
    taskId: string;
    stepId: string;
    worker: ScoutAgent;
    request: string;
    requestId?: string;
  }): Promise<AgentHumanInputRequestResult> {
    const coordinator = this.resolveCoordinator(input.worker.agentId);
    const existing = input.requestId
      ? this.findRequest(input.taskId, input.requestId)
      : this.findUnresolvedRequests(input.taskId)[0];
    if (input.requestId && !existing) {
      throw new Error(
        `Worker task ${input.taskId} is missing recorded human request ${input.requestId}.`,
      );
    }
    if (existing) {
      if (existing.body !== input.request) {
        throw new Error(`Worker task ${input.taskId} already has unresolved human request ${existing.requestId}.`);
      }
      const closed = this.isRequestClosed(existing);
      return {
        status: closed ? "accepted" : "queued",
        taskId: input.taskId,
        agentId: coordinator.agentId,
        requestId: existing.requestId,
        created: false,
        message: closed ? undefined : existing.message,
      };
    }

    const created = await this.publishRequest({
      taskId: input.taskId,
      stepId: input.stepId,
      worker: input.worker,
      coordinator,
      request: input.request,
    });
    return {
      status: "queued",
      taskId: input.taskId,
      agentId: coordinator.agentId,
      requestId: created.requestId,
      created: true,
      message: created.message,
    };
  }

  resolveResponse(taskId: string, response: string): AgentHumanInputResponseTarget {
    const unresolved = this.findUnresolvedRequests(taskId);
    if (unresolved.length === 0) {
      const responded = this.findResponseByBody(taskId, response);
      if (!responded?.response) {
        throw new Error(`Worker task ${taskId} has no unresolved human request.`);
      }
      return {
        requestId: responded.requestId,
        response: responded.response,
      };
    }
    if (unresolved.length !== 1 || !unresolved[0]) {
      throw new Error(`Worker task ${taskId} must have exactly one unresolved human request.`);
    }
    return { requestId: unresolved[0].requestId };
  }

  isRequestClosed(request: AgentHumanInputState): boolean {
    return request.requestConsumption !== undefined || request.response !== undefined;
  }

  resolveCoordinator(workerAgentId: string): ScoutAgent {
    const coordinator = this.registry.listAgents().find((candidate) =>
      candidate.role === ScoutAgentRoles.Coordinator
    );
    if (!coordinator) {
      throw new Error(`Worker agent ${workerAgentId} cannot find the Coordinator agent.`);
    }
    return coordinator;
  }

  resolveAgent(agentId: string): ScoutAgent {
    return this.registry.resolveAgent(agentId);
  }

  async deliverMessage(
    target: ScoutAgent,
    message: Pick<AgentMessage, "messageId" | "body" | "queuedAt">,
    taskId?: string,
  ): Promise<void> {
    const delivered = await target.sendMessage({
      taskId,
      message: message.body,
      delivery: {
        messageId: message.messageId,
        queuedAt: message.queuedAt,
      },
    });
    if (!delivered.ok) throw new Error(delivered.error);
  }

  async publishRequest(input: {
    taskId: string;
    stepId: string;
    worker: ScoutAgent;
    coordinator: ScoutAgent;
    request: string;
  }): Promise<{ requestId: string; message: AgentMessage }> {
    const requestId = `${input.taskId}-human-${randomUUID()}`;
    const requestedAt = new Date().toISOString();
    const message: AgentMessage = {
      messageId: `${requestId}-request`,
      agentId: input.coordinator.agentId,
      body: attachments.compose(agent.turn.wait_for_human_request(input.request)),
      queuedAt: requestedAt,
    };
    await this.eventBus.publishAndWait(AgentEvents.humanInput.requested, {
      requestId,
      stepId: input.stepId,
      taskId: input.taskId,
      agentId: input.worker.agentId,
      body: input.request,
      requestedAt,
      message,
    }, { occurredAt: requestedAt });
    return { requestId, message };
  }

  async publishResponse(input: {
    requestId: string;
    stepId: string;
    taskId: string;
    agentId: string;
    target: ScoutAgent;
    response: string;
  }): Promise<{ message: AgentMessage; respondedAt: string }> {
    const respondedAt = new Date().toISOString();
    const message: AgentMessage = {
      messageId: `${input.requestId}-response`,
      agentId: input.target.agentId,
      taskId: input.taskId,
      body: attachments.compose(agent.turn.human_response(input.response)),
      queuedAt: respondedAt,
    };
    await this.eventBus.publishAndWait(AgentEvents.humanInput.responded, {
      requestId: input.requestId,
      stepId: input.stepId,
      taskId: input.taskId,
      agentId: input.agentId,
      body: input.response,
      respondedAt,
      message,
    }, { occurredAt: respondedAt });
    return { message, respondedAt };
  }
}

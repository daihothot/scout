import type { DynamicToolCallResponse } from "../../../../agent-server/types.js";
import type { AgentDynamicToolSpec } from "../../../../agent/tools/types.js";
import { DomainAgentBackend, type DomainAgentTool } from "../../../agent/index.js";
import { buildExecutionPlatformDynamicTool } from "./tools/agent-tools.js";
import type { ScoutDomainDynamicToolCall } from "../../../types.js";
import { BaseDomainEvents, type BaseDomainAgentToolCallObservedEvent } from "../base-domain-events.js";
import { currentRunScope } from "../../../../run/run-scope.js";

/** Executes Base tools and publishes completion facts for independent consumers. */
export class BaseDomainAgentBackend extends DomainAgentBackend {
  readonly toolDefinitions: readonly AgentDynamicToolSpec[];

  constructor(
    private readonly executionPlatformTool: DomainAgentTool,
  ) {
    super();
    this.toolDefinitions = [buildExecutionPlatformDynamicTool()];
  }

  override async handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse | undefined> {
    if (!this.toolDefinitions.some((spec) =>
      spec.name === call.input.tool && (spec.namespace ?? null) === call.input.namespace
    )) return undefined;
    const startedAt = new Date().toISOString();
    let response: DynamicToolCallResponse;
    try {
      response = await this.executionPlatformTool.execute(call);
    } catch (error) {
      response = failure(error instanceof Error ? error.stack ?? error.message : String(error));
    }
    const completedAt = new Date().toISOString();
    const observation: BaseDomainAgentToolCallObservedEvent = {
      callId: call.input.callId,
      ...(call.caller.threadId ? { threadId: call.caller.threadId } : {}),
      agentId: call.caller.agentId,
      role: call.caller.role,
      phase: call.caller.phase,
      namespace: call.input.namespace ?? "",
      tool: call.input.tool,
      arguments: structuredClone(call.input.arguments),
      response: structuredClone(response),
      startedAt,
      completedAt,
    };
    const scope = currentRunScope();
    await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, observation, {
      occurredAt: completedAt,
    });
    scope.logger.info({
      module: "domain.base.agent.tool_call",
      event: BaseDomainEvents.agentToolCall.observed.routeKey,
      agentId: observation.agentId,
      message: `Base Domain handled ${observation.namespace}/${observation.tool}.`,
      data: observation,
    });
    return response;
  }
}

function failure(message: string): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({ status: "failed", message }, null, 2),
    }],
  };
}

import type { DynamicToolCallResponse } from "../../../../../agent-server/types.js";
import type { AgentDynamicToolSpec } from "../../../../../agent/tools/types.js";
import { currentRunScope } from "../../../../../run/run-scope.js";
import { DomainAgentBackend, type DomainAgentTool } from "../../../../agent/index.js";
import { buildJarvisBehaviorDynamicTool, buildSearchExecutionPackDynamicTool } from "../tools/agent-tools.js";
import { DomainEvents } from "../../../../domain-events.js";
import { ScoutDomainId, type ScoutDomainDynamicToolCall } from "../../../../types.js";

/** Executes RBT Agent tools and publishes their completed call observations. */
export class RbtDomainAgentBackend extends DomainAgentBackend {
  readonly toolDefinitions: readonly AgentDynamicToolSpec[];

  constructor(
    private readonly behaviorTool: DomainAgentTool,
    private readonly searchExecutionPackTool: DomainAgentTool,
  ) {
    super();
    this.toolDefinitions = [
      buildJarvisBehaviorDynamicTool(),
      buildSearchExecutionPackDynamicTool(),
    ];
  }

  override async handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse | undefined> {
    const definition = this.toolDefinitions.find((tool) =>
      tool.name === call.input.tool && (tool.namespace ?? null) === call.input.namespace
    );
    if (!definition) return undefined;
    const startedAt = new Date().toISOString();
    let response: DynamicToolCallResponse;
    try {
      const tool = definition.name === "JarvisBehavior" ? this.behaviorTool : this.searchExecutionPackTool;
      response = await tool.execute(call);
    } catch (error) {
      response = failedResponse(error instanceof Error ? error.stack ?? error.message : String(error));
    }
    const completedAt = new Date().toISOString();
    currentRunScope().eventBus.publish(DomainEvents.agentToolCall.observed, {
      domainId: ScoutDomainId.Rbt,
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
    }, { occurredAt: completedAt });
    return response;
  }
}

function failedResponse(message: string): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{
      type: "inputText",
      text: JSON.stringify({ status: "failed", message }, null, 2),
    }],
  };
}

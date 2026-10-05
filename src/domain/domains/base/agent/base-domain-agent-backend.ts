import type { DynamicToolCallResponse } from "../../../../agent-server/types.js";
import type { AgentDynamicToolSpec } from "../../../../agent/tools/types.js";
import { DomainAgentBackend, type DomainAgentTool } from "../../../agent/index.js";
import { executionPlatformAgentTool } from "./tools/agent-tools.js";
import type { ScoutDomainDynamicToolCall } from "../../../types.js";
import { BaseDomainEvents } from "../base-domain-events.js";
import type { BaseDomainToolCallStore } from "../base-domain-tool-call-store.js";
import { currentRunScope } from "../../../../run/run-scope.js";

/** Executes and records Agent calls owned by the shared Base Domain. */
export class BaseDomainAgentBackend extends DomainAgentBackend {
  readonly toolDefinitions: readonly AgentDynamicToolSpec[] = [executionPlatformAgentTool];

  constructor(
    private readonly toolCallStore: BaseDomainToolCallStore,
    private readonly executionPlatformTool: DomainAgentTool,
  ) {
    super();
  }

  override async handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse | undefined> {
    if (call.input.tool !== executionPlatformAgentTool.name
      || call.input.namespace !== executionPlatformAgentTool.namespace) return undefined;
    const startedAt = new Date().toISOString();
    let response: DynamicToolCallResponse;
    try {
      response = await this.executionPlatformTool.execute(call);
    } catch (error) {
      response = failure(error instanceof Error ? error.stack ?? error.message : String(error));
    }
    const completedAt = new Date().toISOString();
    const stored = this.toolCallStore.record({
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
    });
    const scope = currentRunScope();
    await scope.eventBus.publishAndWait(BaseDomainEvents.agentToolCall.observed, stored, {
      occurredAt: completedAt,
    });
    scope.logger.info({
      module: "domain.base.agent.tool_call",
      event: BaseDomainEvents.agentToolCall.observed.routeKey,
      agentId: stored.agentId,
      message: `Base Domain handled ${stored.namespace}/${stored.tool}.`,
      data: stored,
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

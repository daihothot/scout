import type { DynamicToolCallResponse } from "../../../../../agent-server/types.js";
import { currentRunScope } from "../../../../../run/run-scope.js";
import { DomainAgentBackend } from "../../../../agent/index.js";
import { DomainEvents } from "../../../../domain-events.js";
import { ScoutDomainId, type ScoutDomainDynamicToolCall } from "../../../../types.js";

/** Executes RBT Agent tools and publishes their completed call observations. */
export class RbtDomainAgentBackend extends DomainAgentBackend {
  override async handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse> {
    const startedAt = new Date().toISOString();
    let response: DynamicToolCallResponse;
    try {
      const registered = this.toolsByPhase.get(call.caller.phase)?.get(
        this.toolIdentity(call.input.namespace, call.input.tool),
      );
      if (!registered) {
        response = failedResponse(
          `RBT dynamic tool ${call.input.namespace ?? "<none>"}/${call.input.tool} is not registered for Phase ${call.caller.phase}.`,
        );
      } else {
        response = await registered.tool.execute(call);
      }
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

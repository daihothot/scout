import type { DynamicToolCallResponse } from "../../../../agent-server/types.js";
import { UnityPipelineTool } from "../../../tools/index.js";
import type { ScoutDomainDynamicToolCall } from "../../../types.js";
import {
  JarvisBehaviorTool,
  RbtAgentDynamicToolImplementations,
  rbtAgentDynamicToolRegistrations,
  type RbtAgentDynamicTool,
  type RbtAgentDynamicToolImplementation,
} from "../tools/index.js";
import { JarvisWebsocktTool } from "../tools/index.js";

export interface RbtAgentDynamicToolFactories {
  unityPipeline?: () => RbtAgentDynamicTool;
  jarvisWebsockt?: () => JarvisWebsocktTool;
  jarvisBehavior?: (
    phase: "execute" | "review",
    websocket?: JarvisWebsocktTool,
  ) => RbtAgentDynamicTool;
}

/** Creates registered RBT tools and routes each call to its Phase-owned instance. */
export class RbtAgentDynamicToolBackend {
  private readonly toolsByPhase = new Map<string, Map<string, RbtAgentDynamicTool>>();
  private readonly websocket: JarvisWebsocktTool;

  constructor(factories: RbtAgentDynamicToolFactories = {}) {
    this.websocket = factories.jarvisWebsockt?.() ?? new JarvisWebsocktTool();
    for (const registration of rbtAgentDynamicToolRegistrations) {
      const tool = createTool(registration.implementation, factories, this.websocket);
      const phaseTools = this.toolsByPhase.get(registration.phase)
        ?? new Map<string, RbtAgentDynamicTool>();
      const identity = toolIdentity(
        registration.definition.namespace,
        registration.definition.name,
      );
      if (phaseTools.has(identity)) {
        throw new Error(
          `RBT dynamic tool ${registration.definition.name} is registered twice for Phase ${registration.phase}.`,
        );
      }
      phaseTools.set(identity, tool);
      this.toolsByPhase.set(registration.phase, phaseTools);
    }
  }

  async handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse> {
    const phaseTools = this.toolsByPhase.get(call.caller.phase);
    if (!phaseTools) {
      return failedResponse(`RBT Phase ${call.caller.phase} has no registered dynamic tools.`);
    }
    const tool = phaseTools.get(toolIdentity(call.input.namespace, call.input.tool));
    if (!tool) {
      return failedResponse(
        `RBT dynamic tool ${call.input.namespace ?? "<none>"}/${call.input.tool} is not registered for Phase ${call.caller.phase}.`,
      );
    }
    return tool.execute(call);
  }

  async stop(): Promise<void> {
    const tools = new Set(
      [...this.toolsByPhase.values()].flatMap((phaseTools) => [...phaseTools.values()]),
    );
    await Promise.all([...tools].map((tool) => tool.stop?.()));
    await this.websocket.stop();
  }
}

function createTool(
  implementation: RbtAgentDynamicToolImplementation,
  factories: RbtAgentDynamicToolFactories,
  websocket: JarvisWebsocktTool,
): RbtAgentDynamicTool {
  switch (implementation) {
    case RbtAgentDynamicToolImplementations.UnityPipeline:
      return factories.unityPipeline?.() ?? new UnityPipelineTool();
    case RbtAgentDynamicToolImplementations.JarvisWebsockt:
      return websocket;
    case RbtAgentDynamicToolImplementations.JarvisBehaviorExecute:
      return factories.jarvisBehavior?.("execute", websocket)
        ?? new JarvisBehaviorTool("execute", undefined, undefined, undefined, undefined, websocket);
    case RbtAgentDynamicToolImplementations.JarvisBehaviorReview:
      return factories.jarvisBehavior?.("review", websocket)
        ?? new JarvisBehaviorTool("review", undefined, undefined, undefined, undefined, websocket);
  }
}

function toolIdentity(namespace: string | null | undefined, tool: string): string {
  return `${namespace ?? ""}\u0000${tool}`;
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

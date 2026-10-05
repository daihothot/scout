import type { DynamicToolCallResponse } from "../../agent-server/types.js";
import type { AgentDynamicToolSpec } from "../../agent/tools/types.js";
import type { ScoutDomainDynamicToolCall } from "../types.js";

/** Executable business tool owned by a Domain. */
export interface DomainAgentTool {
  execute(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse> | DynamicToolCallResponse;
}

/** Supplies tool definitions and executes Domain calls; Workflow configuration owns allocation. */
export abstract class DomainAgentBackend {
  abstract readonly toolDefinitions: readonly AgentDynamicToolSpec[];

  abstract handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse | undefined>;
}

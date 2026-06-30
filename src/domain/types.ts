import type { AgentDynamicToolSpec, ScoutAgentRole } from "../agent/model/types.js";
import type {
  DynamicToolCallInput,
  DynamicToolCallResult,
} from "../agent-server/types.js";

export interface ScoutDomainDynamicToolCall {
  input: DynamicToolCallInput;
  caller: {
    agentId: string;
    role: ScoutAgentRole;
    threadId?: string;
  };
}

export interface ScoutDomain {
  readonly domainId: string;
  readonly name: string;
  dynamicToolsForRole(role: ScoutAgentRole): AgentDynamicToolSpec[];
  handleDynamicToolCall?(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResult | undefined> | DynamicToolCallResult | undefined;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

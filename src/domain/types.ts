import type { ScoutAgentRole } from "../agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../agent/tools/types.js";
import type {
  DynamicToolCallInput,
  DynamicToolCallResponse,
} from "../agent-server/types.js";

/** Dynamic-tool invocation forwarded from an agent server into a domain backend. */
export interface ScoutDomainDynamicToolCall {
  input: DynamicToolCallInput;
  caller: {
    agentId: string;
    role: ScoutAgentRole;
    threadId?: string;
  };
}

/** Lifecycle and tool surface owned by a Scout domain implementation. */
export interface ScoutDomain {
  readonly domainId: string;
  readonly name: string;
  dynamicToolsForRole(role: ScoutAgentRole): AgentDynamicToolSpec[];
  handleDynamicToolCall?(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse | undefined> | DynamicToolCallResponse | undefined;
  restore?(): Promise<void> | void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

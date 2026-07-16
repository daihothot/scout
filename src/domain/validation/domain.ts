import type { ScoutAgentRole } from "../../agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../../agent/tools/types.js";
import type {
  ScoutDomain,
  ScoutDomainDynamicToolCall,
} from "../types.js";
import { ValidationDomainAgentBackend } from "./agent/backend/validation-domain-agent-backend.js";
import type { DynamicToolCallResponse } from "../../agent-server/types.js";

export class ValidationDomain implements ScoutDomain {
  readonly domainId = "validation";
  readonly name = "Scout Validation Domain";
  readonly backend = new ValidationDomainAgentBackend();

  dynamicToolsForRole(_role: ScoutAgentRole): AgentDynamicToolSpec[] {
    return [];
  }

  handleDynamicToolCall(call: ScoutDomainDynamicToolCall): DynamicToolCallResponse | undefined {
    return this.backend.handleDynamicToolCall(call);
  }
}

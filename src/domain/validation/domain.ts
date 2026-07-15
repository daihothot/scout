import type { ScoutAgentRole } from "../../agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../../agent/tools/types.js";
import type {
  ScoutDomain,
  ScoutDomainDynamicToolCall,
} from "../types.js";
import { ValidationDomainAgentBackend } from "./agent/backend/validation-domain-agent-backend.js";
import { buildValidationDomainToolsForRole } from "./tools/validation-domain-tools.js";
import type { DynamicToolCallResponse } from "../../agent-server/types.js";

export interface ValidationDomainOptions {
  runId: string;
}

export class ValidationDomain implements ScoutDomain {
  readonly domainId = "validation";
  readonly name = "Scout Validation Domain";
  readonly backend: ValidationDomainAgentBackend;
  private readonly runId: string;

  constructor(options: ValidationDomainOptions) {
    this.runId = options.runId;
    this.backend = new ValidationDomainAgentBackend({
      runId: options.runId,
    });
  }

  dynamicToolsForRole(role: ScoutAgentRole): AgentDynamicToolSpec[] {
    return buildValidationDomainToolsForRole(role);
  }

  async start(): Promise<void> {
    void this.runId;
  }

  handleDynamicToolCall(call: ScoutDomainDynamicToolCall): DynamicToolCallResponse | undefined {
    return this.backend.handleDynamicToolCall(call);
  }
}

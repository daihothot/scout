import type { AgentDynamicToolSpec, ScoutAgentRole } from "../../agent/model/types.js";
import type {
  ScoutDomain,
  ScoutDomainDynamicToolCall,
} from "../types.js";
import { ValidationDomainAgentBackend } from "./agent/backend/validation-domain-agent-backend.js";
import { buildValidationDomainToolsForRole } from "./tools/validation-domain-tools.js";
import type { DynamicToolCallResult } from "../../agent-server/types.js";

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

  handleDynamicToolCall(call: ScoutDomainDynamicToolCall): DynamicToolCallResult | undefined {
    return this.backend.handleDynamicToolCall(call);
  }
}

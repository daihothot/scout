import type { DynamicToolCallResponse } from "../../../../../agent-server/types.js";
import { DomainAgentBackend } from "../../../../agent/index.js";
import type { ScoutDomainDynamicToolCall } from "../../../../types.js";

/** Domain backend boundary for validation-specific dynamic tools. */
export class ValidationDomainAgentBackend extends DomainAgentBackend {
  /** Returns no tool response because validation currently exposes no dynamic tools. */
  override async handleDynamicToolCall(_call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse | undefined> {
    return undefined;
  }
}

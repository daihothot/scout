import type { DynamicToolCallResponse } from "../../../../agent-server/types.js";
import type { ScoutDomainDynamicToolCall } from "../../../types.js";

/** Domain backend boundary for validation-specific dynamic tools. */
export class ValidationDomainAgentBackend {
  /** Returns no tool response because validation currently exposes no dynamic tools. */
  handleDynamicToolCall(_call: ScoutDomainDynamicToolCall): DynamicToolCallResponse | undefined {
    return undefined;
  }
}

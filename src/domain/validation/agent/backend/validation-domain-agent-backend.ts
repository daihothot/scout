import type { DynamicToolCallResponse } from "../../../../agent-server/types.js";
import type { ScoutDomainDynamicToolCall } from "../../../types.js";

export class ValidationDomainAgentBackend {
  handleDynamicToolCall(_call: ScoutDomainDynamicToolCall): DynamicToolCallResponse | undefined {
    return undefined;
  }
}

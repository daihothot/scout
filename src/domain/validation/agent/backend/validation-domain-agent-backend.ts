import type { DynamicToolCallResult } from "../../../../agent-server/types.js";
import type { ScoutDomainDynamicToolCall } from "../../../types.js";
import { buildValidationStateSnapshot } from "../../model/index.js";
import {
  GET_VALIDATION_STATE_SNAPSHOT_TOOL,
  VALIDATION_DOMAIN_TOOL_NAMESPACE,
} from "../../tools/validation-domain-tools.js";

export class ValidationDomainAgentBackend {
  private readonly runId: string;
  private snapshotSequence = 0;

  constructor(input: { runId: string }) {
    this.runId = input.runId;
  }

  handleDynamicToolCall(call: ScoutDomainDynamicToolCall): DynamicToolCallResult | undefined {
    if (
      call.input.namespace !== VALIDATION_DOMAIN_TOOL_NAMESPACE
      || call.input.tool !== GET_VALIDATION_STATE_SNAPSHOT_TOOL
    ) {
      return undefined;
    }

    this.snapshotSequence += 1;
    const snapshot = buildValidationStateSnapshot({
      runId: this.runId,
      snapshotId: `${this.runId}:validation-state:${this.snapshotSequence}`,
      observedAt: new Date().toISOString(),
    });
    return {
      success: true,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({
          domainId: "validation",
          caller: call.caller,
          snapshot,
        }, null, 2),
      }],
    };
  }
}

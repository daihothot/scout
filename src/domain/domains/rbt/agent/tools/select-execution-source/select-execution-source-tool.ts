import type { DynamicToolCallResponse } from "../../../../../../agent-server/types.js";
import { currentRunScope } from "../../../../../../run/run-scope.js";
import type { DomainAgentTool } from "../../../../../agent/domain-agent-backend.js";
import { ScoutDomainId, type ScoutDomainDynamicToolCall } from "../../../../../types.js";
import { isRbtPlatform } from "../../../config/index.js";
import { RbtDomain } from "../../../rbt-domain.js";

/** Binds the Executor's confirmed task platform; the tool owns no selection state. */
export class SelectExecutionSourceTool implements DomainAgentTool {
  async execute(call: ScoutDomainDynamicToolCall): Promise<DynamicToolCallResponse> {
    if (call.caller.phase !== "execute") throw new Error("SelectExecutionSource is only available in execute Phase.");
    const input = call.input.arguments;
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => key !== "platform")
      || !("platform" in input) || !isRbtPlatform(input.platform)) {
      throw new Error("SelectExecutionSource requires one valid platform field.");
    }
    const domain = currentRunScope().domainRegistry.get(ScoutDomainId.Rbt);
    if (!(domain instanceof RbtDomain)) throw new Error("Registered RBT Domain has an invalid runtime type.");
    await domain.selectExecutionSource(input.platform);
    return {
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify({ status: "selected", platform: input.platform }) }],
    };
  }
}

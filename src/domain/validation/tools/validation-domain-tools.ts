import type { AgentDynamicToolSpec, ScoutAgentRole } from "../../../agent/model/types.js";
import { ScoutAgentRoles } from "../../../agent/model/types.js";

export const VALIDATION_DOMAIN_TOOL_NAMESPACE = "scout.domain.validation";
export const GET_VALIDATION_STATE_SNAPSHOT_TOOL = "GetValidationStateSnapshot";

export function buildValidationDomainToolsForRole(role: ScoutAgentRole): AgentDynamicToolSpec[] {
  if (role === ScoutAgentRoles.Coordinator) {
    return [buildGetValidationStateSnapshotDynamicTool()];
  }
  return [];
}

export function buildGetValidationStateSnapshotDynamicTool(): AgentDynamicToolSpec {
  return {
    namespace: VALIDATION_DOMAIN_TOOL_NAMESPACE,
    name: GET_VALIDATION_STATE_SNAPSHOT_TOOL,
    description: "读取 Validation Domain 当前业务状态快照。Coordinator 需要观察业务状态时主动调用。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

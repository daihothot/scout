/** JSON-compatible value used for dynamic-tool schemas and configuration. */
export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue };

/** Scout-owned dynamic tool definition and its required operational Skill. */
export interface AgentDynamicToolSpec {
  guidanceSkill: string;
  namespace?: string;
  name: string;
  description: string;
  inputSchema: AgentJsonValue;
  deferLoading?: boolean;
}

export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue };

export interface AgentDynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: AgentJsonValue;
  deferLoading?: boolean;
}

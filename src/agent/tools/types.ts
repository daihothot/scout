/** JSON-compatible value used for dynamic-tool schemas and configuration. */
export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue };

/** Dynamic tool definition registered with the app-server thread. */
export interface AgentDynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: AgentJsonValue;
  deferLoading?: boolean;
}

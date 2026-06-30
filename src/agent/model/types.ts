export const ScoutAgentRoles = {
  Coordinator: "coordinator",
  Researcher: "researcher",
  Verifier: "verifier",
  Validator: "validator",
} as const;

export type ScoutAgentRole = typeof ScoutAgentRoles[keyof typeof ScoutAgentRoles];

export const ScoutAgentPhases = {
  Coordinate: "coordinate",
  Research: "research",
  Verify: "verify",
  Validate: "validate",
} as const;

export type ScoutAgentPhase = typeof ScoutAgentPhases[keyof typeof ScoutAgentPhases];

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

export interface AgentThreadSpec {
  role: ScoutAgentRole;
  phases: ScoutAgentPhase[];
  cwd: string;
  approvalPolicy: "never";
  sandbox: "read-only" | "workspace-write";
  contextBundleId: string;
  config?: Record<string, AgentJsonValue>;
  baseInstructions?: string;
  developerInstructions?: string;
  dynamicTools?: AgentDynamicToolSpec[];
}

export interface AgentThreadRecord {
  role: ScoutAgentRole;
  phases: ScoutAgentPhase[];
  threadId: string;
  request: AgentThreadSpec;
  effective: {
    approvalPolicy?: string;
    sandboxType?: string;
    sandboxNetworkAccess?: boolean;
    reasoningEffort?: string;
    cwd?: string;
  };
  response: unknown;
}

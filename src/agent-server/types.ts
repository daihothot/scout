export interface AgentServerPreflightResult {
  status: "passed" | "failed";
  isolatedHome: string;
  isolatedCodexHome: string;
  configLayers?: unknown[];
  skillsList?: unknown;
  pluginList?: unknown;
  pluginInstalled?: unknown;
  pluginInstall?: unknown;
  pluginInstalledAfterInstall?: unknown;
  pluginGate?: {
    marketplacePath: string;
    plugins: Array<{
      pluginName: string;
      installedBefore: boolean;
      enabledBefore: boolean;
      installedAfter: boolean;
      enabledAfter: boolean;
    }>;
    status: "passed" | "failed";
  };
  hooksList?: unknown;
  shellSmoke?: Array<{
    command: string;
    status: "passed" | "failed";
    stdout?: string;
    stderr?: string;
    error?: string;
  }>;
  error?: string;
}

export interface ThreadPreflightResult {
  status: "passed" | "failed";
  threadId: string;
  mcpServerStatus?: unknown;
  mcpSmoke?: Array<{
    server: string;
    tool?: string;
    status: "passed" | "failed" | "skipped";
    result?: unknown;
    error?: string;
  }>;
  error?: string;
}

export interface DynamicToolCallInput {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolCallResult {
  success: boolean;
  contentItems: Array<{
    type: "inputText";
    text: string;
  }>;
}

export type DynamicToolCallHandler = (
  input: DynamicToolCallInput,
) => Promise<DynamicToolCallResult> | DynamicToolCallResult;

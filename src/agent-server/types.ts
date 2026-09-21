import type {
  MountRootAccessReport,
  MountShellSmokeResult,
} from "../asset-store/mount/preflight.js";

/** Portable diagnostics produced while checking one mounted Codex app-server. */
export interface AgentServerPreflightReport {
  status: "passed" | "failed";
  rootAccess?: MountRootAccessReport;
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
  shellSmoke?: MountShellSmokeResult[];
  error?: string;
}

/** MCP connectivity and smoke-test result for one resumed or started thread. */
export interface ThreadPreflightReport {
  status: "passed" | "failed";
  threadId: string;
  mcpSmoke?: Array<{
    server: string;
    tool?: string;
    status: "passed" | "failed" | "skipped";
    result?: unknown;
    error?: string;
  }>;
  error?: string;
}

/** Identity and arguments supplied by Codex for a dynamic-tool request. */
export interface DynamicToolCallInput {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

/** Content items returned to Codex after a dynamic-tool invocation. */
export interface DynamicToolCallResponse {
  success: boolean;
  contentItems: Array<{
    type: "inputText";
    text: string;
  }>;
}

/** Callback contract used by the app-server client to execute dynamic tools. */
export type DynamicToolCallHandler = (
  input: DynamicToolCallInput,
) => Promise<DynamicToolCallResponse> | DynamicToolCallResponse;

/**
 * Declarative and resolved shell/MCP resource contracts. This module describes
 * resource shapes without reading registries or resolving executable paths.
 */

/** Repository MCP server contracts selected by an agent profile. */
export interface McpServersFile {
  servers: Record<string, {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    trustedRoots?: string[];
    writableRoots?: string[];
    smoke?: {
      tool: string;
      arguments?: Record<string, unknown>;
    };
  }>;
}

/** MCP contract after command, paths, environment, and wrapper location are resolved. */
export interface MaterializedMcpServer {
  name: string;
  wrapperPath: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  trustedRoots: string[];
  writableRoots: string[];
  smoke?: {
    tool: string;
    arguments?: Record<string, unknown>;
  };
}

/** Top-level shell-tool registry loaded from the asset repository. */
export interface ShellToolsFile {
  tools: ShellToolContract[];
}

/** Declarative shell command contract used to build a mount-local executable wrapper. */
export interface ShellToolContract {
  id: string;
  name: string;
  command: string;
  args?: string[];
  exposeAs: string;
  required: boolean;
  smokeArgs?: string[];
  marker?: string;
}

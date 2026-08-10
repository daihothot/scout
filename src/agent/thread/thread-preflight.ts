import type { ThreadPreflightReport } from "../../agent-server/types.js";
import type { CodexMount } from "../../asset-store/contracts/mount.js";
import { currentRunScope } from "../../run/run-scope.js";
import type { AgentThreadSnapshot } from "./types.js";

/** Persisted result of the MCP/thread smoke checks for one agent thread. */
export interface ScoutAgentThreadPreflightSnapshot {
  agentId: string;
  role: AgentThreadSnapshot["role"];
  threadId: string;
  checkedAt: string;
  result: ThreadPreflightReport;
}

/** Runs non-mutating MCP status and smoke checks against an active thread. */
export async function runThreadPreflight(input: {
  agentId: string;
  thread: AgentThreadSnapshot;
  mount: CodexMount;
}): Promise<ScoutAgentThreadPreflightSnapshot> {
  return {
    agentId: input.agentId,
    role: input.thread.role,
    threadId: input.thread.threadId,
    checkedAt: new Date().toISOString(),
    result: await checkThread(input),
  };
}

async function checkThread(input: {
  thread: AgentThreadSnapshot;
  mount: CodexMount;
}): Promise<ThreadPreflightReport> {
  const appServer = currentRunScope().appServer;
  try {
    const mcpServerStatus = await appServer.request("mcpServerStatus/list", {
      threadId: input.thread.threadId,
      detail: "full",
    });
    const mcpSmoke = await Promise.all(input.mount.mcpServers.map(async (server) => {
      if (!server.smoke) {
        return {
          server: server.name,
          status: "skipped" as const,
          error: "missing smoke contract",
        };
      }
      try {
        const result = await appServer.request("mcpServer/tool/call", {
          threadId: input.thread.threadId,
          server: server.name,
          tool: server.smoke.tool,
          arguments: server.smoke.arguments ?? {},
        });
        const error = readMcpToolError(result);
        return {
          server: server.name,
          tool: server.smoke.tool,
          status: error ? "failed" as const : "passed" as const,
          result,
          error,
        };
      } catch (error) {
        return {
          server: server.name,
          tool: server.smoke.tool,
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    return {
      status: mcpSmoke.some((item) => item.status === "failed") ? "failed" : "passed",
      threadId: input.thread.threadId,
      mcpServerStatus,
      mcpSmoke,
    };
  } catch (error) {
    return {
      status: "failed",
      threadId: input.thread.threadId,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
}

function readMcpToolError(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.isError === true) return JSON.stringify(value);
  if (isPlainObject(value.error)) return JSON.stringify(value.error);
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

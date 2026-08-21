/** Provider tool-call facts owned by the Tool Call store. */
export type AgentToolCallKind = "dynamic" | "mcp";

export type AgentToolCallStatus = "inProgress" | "completed" | "failed" | "cancelled" | string;

/** Durable identity and outcome for one dynamic or MCP tool item. */
export interface AgentToolCallState {
  toolCallId: string;
  kind: AgentToolCallKind;
  agentId: string;
  taskId?: string;
  stepId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  namespace?: string | null;
  server?: string;
  tool: string;
  arguments?: unknown;
  status: AgentToolCallStatus;
  success?: boolean | null;
  result?: unknown;
  error?: unknown;
  contentItems?: unknown[] | null;
  sourceSeq: number;
  observedAt: string;
  finishedAt?: string;
}

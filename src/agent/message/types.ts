/** Durable message envelope passed between Scout agents. */
export interface AgentMessage {
  messageId: string;
  agentId: string;
  taskId?: string;
  body: string;
  queuedAt: string;
}

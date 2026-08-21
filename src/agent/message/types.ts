/** Durable message envelope passed between Scout agents. */
export type AgentMessageDeliveryMode = "steer" | "queued";

export interface AgentMessage {
  messageId: string;
  agentId: string;
  taskId?: string;
  body: string;
  queuedAt: string;
  /** Requested delivery behavior. Omitted values use the steer default. */
  deliveryMode?: AgentMessageDeliveryMode;
}

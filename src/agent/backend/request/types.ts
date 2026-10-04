/** The actual native caller is recorded anew for every approval. */
export interface AgentPermissionConsumer {
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly phase: string;
  readonly cwd: string;
  readonly environmentId: "local";
}

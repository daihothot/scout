/** Scout-owned input routed from a provider-native synchronous hook. */
export interface CommandExecutionApprovalHookInvocation {
  kind: "command_execution_approval";
  runId: string;
  agentId: string;
  invocationId: string;
  stateRoot: string;
  cwd: string;
  command: string;
}

/** Completion of a command whose synchronous approval state can be released. */
export interface CommandExecutionCompletedHookInvocation {
  kind: "command_execution_completed";
  runId: string;
  agentId: string;
  invocationId: string;
  stateRoot: string;
}

/** Current synchronous hook inputs understood by Scout. */
export type AgentHookInvocation =
  | CommandExecutionApprovalHookInvocation
  | CommandExecutionCompletedHookInvocation;

/** Immediate result returned to the provider-native hook. */
export type AgentHookResult =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

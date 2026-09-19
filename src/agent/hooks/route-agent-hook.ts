import {
  completeCommandExecutionApproval,
  evaluateCommandExecutionApproval,
} from "../command-execution/approval/command-execution-approval-policy.js";
import type { AgentHookInvocation, AgentHookResult } from "./types.js";

/** Routes one synchronous native-hook invocation to its owning Agent consumer. */
export function routeAgentHook(invocation: AgentHookInvocation): AgentHookResult {
  switch (invocation.kind) {
    case "command_execution_approval":
      return evaluateCommandExecutionApproval(invocation.command, {
        stateRoot: invocation.stateRoot,
        invocationId: invocation.invocationId,
      });
    case "command_execution_completed":
      completeCommandExecutionApproval(invocation.stateRoot, invocation.invocationId);
      return { decision: "allow" };
  }
}

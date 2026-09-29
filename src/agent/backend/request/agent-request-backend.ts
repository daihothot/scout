import { currentRunScope } from "../../../run/run-scope.js";
import { AgentRequestApprovalBackend } from "./agent-request-approval-backend.js";

/** Routes server requests requiring a host response, excluding the dynamic-tool entry. */
export class AgentRequestBackend {
  private readonly scope = currentRunScope();
  private readonly approval = new AgentRequestApprovalBackend();
  private unsubscribe?: () => void;

  start(): void {
    if (this.unsubscribe) return;
    // Registration storage must be installed before the approval entry becomes reachable.
    void this.scope.requestHub;
    this.unsubscribe = this.scope.appServer.onServerRequest((request, controller) => {
      if (request.method !== "item/permissions/requestApproval") return false;
      this.approval.handle(request, controller);
      return true;
    });
  }

  stop(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    unsubscribe?.();
  }
}

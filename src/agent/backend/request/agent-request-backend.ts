import { currentRunScope } from "../../../run/run-scope.js";
import { AgentRequestApprovalBackend, agentPermissionRequestType } from "./agent-request-approval-backend.js";

/** Routes server requests requiring a host response, excluding the dynamic-tool entry. */
export class AgentRequestBackend {
  private readonly scope = currentRunScope();
  private readonly approval = new AgentRequestApprovalBackend();
  private unsubscribe?: () => void;

  start(): void {
    if (this.unsubscribe) return;
    // Authorization must be installed before native approval is reachable.
    this.scope.authorization.registerRequestType(agentPermissionRequestType);
    this.unsubscribe = this.scope.appServer.onServerRequest(async (request, controller) => {
      if (request.method !== "item/permissions/requestApproval") return false;
      await this.approval.handle(request, controller);
      return true;
    });
  }

  stop(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    unsubscribe?.();
  }
}

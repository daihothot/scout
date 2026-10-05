import { currentRunScope } from "../../../run/run-scope.js";
import { AgentRequestApprovalBackend } from "./agent-request-approval-backend.js";

/** Routes server requests requiring a host response, excluding the dynamic-tool entry. */
export class AgentRequestBackend {
  private readonly scope = currentRunScope();
  private readonly approval = new AgentRequestApprovalBackend();
  private unsubscribe?: () => void;

  start(): void {
    if (this.unsubscribe) return;
    // Source types are installed by boot; this consumer still requires the owner before subscribing.
    void this.scope.authorization;
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

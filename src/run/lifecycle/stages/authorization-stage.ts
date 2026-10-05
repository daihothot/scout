import { Authorization } from "../../../core/authorization/authorization.js";
import { agentPermissionRequestSourceType } from "../../../core/authorization/request-source/permission/agent-permission-request-source.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Installs Authorization as one service and one Workflow participant. */
export class AuthorizationStage implements RunStage {
  readonly id = "authorization";
  private authorization?: Authorization;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    if (this.authorization) throw new Error("Authorization startup cleanup is pending; stop the installed services before retrying.");
    const scope = currentRunScope();
    const authorization = new Authorization();
    scope.setAuthorization(authorization);
    this.authorization = authorization;
    authorization.registerRequestSourceType(agentPermissionRequestSourceType);
    authorization.start();
    scope.workflow.registerParticipant(authorization);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.authorization) return;
    this.authorization.stop();
    const scope = currentRunScope();
    if (scope.workflow.participants.includes(this.authorization)) scope.workflow.unregisterParticipant(this.authorization);
    scope.clearAuthorization(this.authorization);
    this.authorization = undefined;
    this.started = false;
  }
}

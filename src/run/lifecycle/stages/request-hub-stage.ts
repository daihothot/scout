import { RequestHub } from "../../../core/requeshub/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Installs the request service; it owns its RecordObject and restoration. */
export class RequestHubStage implements RunStage {
  readonly id = "request_hub";
  private hub?: RequestHub;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    if (this.hub) throw new Error("RequestHub startup cleanup is pending; stop the installed service before retrying.");
    const scope = currentRunScope();
    const hub = new RequestHub();
    scope.setRequestHub(hub);
    this.hub = hub;
    hub.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    hub.close();
    currentRunScope().clearRequestHub(hub);
    this.hub = undefined;
    this.started = false;
  }
}

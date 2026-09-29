import { RequestHub } from "../../../core/requeshub/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Installs a fresh in-memory request service for either startup path. */
export class RequestHubStage implements RunStage {
  readonly id = "request_hub";
  private hub?: RequestHub;

  async start(): Promise<void> {
    if (this.hub) return;
    const hub = new RequestHub();
    currentRunScope().setRequestHub(hub);
    this.hub = hub;
  }

  async stop(): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    hub.close();
    currentRunScope().clearRequestHub(hub);
    this.hub = undefined;
  }
}

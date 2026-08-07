import { AgentBackend } from "../../../agent/backend/agent-backend.js";
import type { RunStage } from "../run-stage.js";

/** Starts and stops the shared backend that executes agent tool work. */
export class AgentBackendStage implements RunStage {
  readonly id = "agent_backend";
  private backend?: AgentBackend;

  async start(): Promise<void> {
    const backend = new AgentBackend();
    backend.start();
    this.backend = backend;
  }

  async stop(): Promise<void> {
    this.backend?.stop();
    this.backend = undefined;
  }
}

import { AgentBackend } from "../../../agent/backend/agent-backend.js";
import type { RunStage } from "../run-stage.js";

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

import { AgentTimelineBackend } from "../../../agent/backend/timeline/agent-timeline-backend.js";
import { AgentDynamicToolBackend } from "../../../agent/backend/dynamic-tool/agent-dynamic-tool-backend.js";
import { AgentRequestBackend } from "../../../agent/backend/request/agent-request-backend.js";
import type { RunStage } from "../run-stage.js";

/** Boots the independent Timeline, dynamic-tool, and server-request entries. */
export class AgentBackendStage implements RunStage {
  readonly id = "agent_backend";
  private timeline?: AgentTimelineBackend;
  private dynamicTool?: AgentDynamicToolBackend;
  private request?: AgentRequestBackend;

  async start(): Promise<void> {
    if (this.timeline) return;
    try {
      this.timeline = new AgentTimelineBackend();
      this.dynamicTool = new AgentDynamicToolBackend();
      this.request = new AgentRequestBackend();
      this.timeline.start();
      this.dynamicTool.start();
      this.request.start();
    } catch (error) {
      try { await this.stop(); }
      catch (stopError) { throw new AggregateError([error, stopError], "Agent backend startup and cleanup failed."); }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const backends = [this.request, this.dynamicTool, this.timeline];
    this.request = undefined;
    this.dynamicTool = undefined;
    this.timeline = undefined;
    const errors: unknown[] = [];
    for (const backend of backends) {
      try { backend?.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Agent backend cleanup failed.");
  }
}

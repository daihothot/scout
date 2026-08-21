import type {
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { AgentTaskBackend } from "./agent-task-backend.js";
import { AgentHumanInputBackend } from "./agent-human-input-backend.js";

/**
 * Applies app-server observations to the running Step owned by an Agent.
 * Task lifecycle policy and disposition remain outside this boundary.
 */
export class AgentStepBackend {
  readonly task: AgentTaskBackend;
  private readonly stepStore: RunScope["stepStore"];

  constructor(input: {
    taskBackend?: AgentTaskBackend;
    humanInputBackend?: AgentHumanInputBackend;
  } = {}) {
    const scope = currentRunScope();
    this.stepStore = scope.stepStore;
    const humanInputBackend = input.humanInputBackend ?? new AgentHumanInputBackend();
    this.task = input.taskBackend ?? new AgentTaskBackend({
      humanInputBackend,
    });
  }

  handleAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolved: AppServerResolvedTimelineEntry,
  ): void {
    switch (entry.stream) {
      case "plan": {
        if (entry.kind !== "plan_updated") return;
        const turnId = resolved.plan?.turnId ?? entry.turnId;
        if (resolved.plan && turnId) {
          this.stepStore.applyPlanObservation(agent.agentId, {
            ...resolved.plan,
            turnId,
          });
        }
        return;
      }
      case "state":
      case "item":
      case "lifecycle":
      case "request":
      return;
    }
  }
}

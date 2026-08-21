import type {
  AppServerPlanState,
  AppServerResolvedTimelineEntry,
  AppServerTimelineEntry,
} from "../../agent-server/codex/app-server-event-store.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { AgentEvents } from "../events/index.js";

/**
 * Applies app-server observations to the running Step owned by an Agent.
 * Task lifecycle policy and disposition remain outside this boundary.
 */
export class AgentStepBackend {
  private readonly stepStore: RunScope["stepStore"];
  private readonly eventBus: RunScope["eventBus"];

  constructor() {
    const scope = currentRunScope();
    this.stepStore = scope.stepStore;
    this.eventBus = scope.eventBus;
  }

  handleAppServerTimelineEntry(
    agent: ScoutAgent,
    entry: AppServerTimelineEntry,
    resolver: AgentStepTimelineResolver,
  ): void {
    switch (entry.stream) {
      case "plan": {
        if (entry.kind !== "plan_updated") return;
        const resolved = resolver(entry);
        const turnId = resolved.plan?.turnId ?? entry.turnId;
        if (resolved.plan && turnId) {
          this.applyPlanUpdate(agent, {
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

  private applyPlanUpdate(
    agent: ScoutAgent,
    plan: AppServerPlanState,
  ): void {
    const runningSteps = this.stepStore.list({ agentId: agent.agentId }).filter((step) =>
      step.status === "running"
    );
    if (runningSteps.length === 0) return;
    if (runningSteps.length !== 1 || !runningSteps[0]) {
      throw new Error(`Agent ${agent.agentId} has multiple running steps for plan update.`);
    }
    const currentStep = runningSteps[0];
    if (currentStep.turnId && currentStep.turnId !== plan.turnId) {
      throw new Error(
        `Agent step ${currentStep.stepId} belongs to turn ${currentStep.turnId}, not ${plan.turnId}.`,
      );
    }
    const updatedAt = new Date().toISOString();
    const step = this.stepStore.updateStep(currentStep.stepId, (current) => ({
      ...current,
      turnId: plan.turnId,
      plan,
      updatedAt,
    }));
    this.eventBus.publish(AgentEvents.step.planUpdated, step, { occurredAt: updatedAt });
  }
}

/** Resolves an app-server timeline entry to its complete Step-oriented view. */
export type AgentStepTimelineResolver = (
  entry: AppServerTimelineEntry,
) => AppServerResolvedTimelineEntry;

import { AgentBuilder } from "../../../agent/builder/agent-builder.js";
import type { ScoutAgent } from "../../../agent/core/scout-agent.js";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../../agent/thread/types.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Builds all role agents, starts their threads, and stops them in role order. */
export class AgentsStage implements RunStage {
  readonly id = "agents";
  private stopped = false;

  async start(): Promise<void> {
    const builder = new AgentBuilder();
    const agents = {
      [ScoutAgentRoles.Coordinator]: builder.buildCoordinator(),
      [ScoutAgentRoles.Researcher]: builder.buildWorker(ScoutAgentRoles.Researcher),
      [ScoutAgentRoles.Verifier]: builder.buildWorker(ScoutAgentRoles.Verifier),
      [ScoutAgentRoles.Validator]: builder.buildWorker(ScoutAgentRoles.Validator),
    } satisfies Record<ScoutAgentRole, ScoutAgent>;
    const settled = await Promise.allSettled(
      Object.values(agents).map((agent) => agent.startThread()),
    );
    const errors = settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      .map((entry) => entry.reason);
    if (errors.length === 0) return;
    await this.stopAgents("agent_startup_failed");
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${errors.length} Scout agents failed to start.`);
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.stopAgents(reason);
  }

  private async stopAgents(reason: string): Promise<void> {
    const agents = currentRunScope().agentRegistry.listAgents();
    const coordinator = agents.find((agent) =>
      agent.role === ScoutAgentRoles.Coordinator
    );
    const workers = agents.filter((agent) =>
      agent.role !== ScoutAgentRoles.Coordinator
    );
    const errors: unknown[] = [];
    if (coordinator) {
      try {
        await coordinator.stopAgent(reason);
      } catch (error) {
        errors.push(error);
      }
    }
    const settled = await Promise.allSettled(
      workers.map((agent) => agent.stopAgent(reason)),
    );
    errors.push(...settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      .map((entry) => entry.reason));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} Scout agent runners failed to stop.`);
    }
  }
}

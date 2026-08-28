import { AgentBuilder } from "../../../agent/builder/agent-builder.js";
import { resolveSynthesisRole } from "../../../core/workflow/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Builds all role agents, starts their threads, and stops them in role order. */
export class AgentsStage implements RunStage {
  readonly id = "agents";
  private stopped = false;

  async start(): Promise<void> {
    const builder = new AgentBuilder();
    const graphState = currentRunScope().scheduler.snapshot();
    const coordinatorRole = resolveSynthesisRole(graphState).name;
    const roles = graphState.roles.map((role) => role.name);
    const agents = roles.map((role) =>
      role === coordinatorRole
        ? builder.buildCoordinator()
        : builder.buildWorker(role)
    );
    const settled = await Promise.allSettled(
      agents.map((agent) => agent.startThread()),
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
    const coordinatorRole = resolveSynthesisRole(
      currentRunScope().scheduler.snapshot(),
    ).name;
    const coordinator = agents.find((agent) =>
      agent.role === coordinatorRole
    );
    const workers = agents.filter((agent) =>
      agent.role !== coordinatorRole
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

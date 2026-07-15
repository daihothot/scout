import {
  AgentBuilder,
  type PreparedAgentInputs,
} from "../../../agent/builder/agent-builder.js";
import type { ScoutAgent } from "../../../agent/core/scout-agent.js";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../../agent/thread/types.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunEnvironment } from "../../types.js";
import type { BootStage } from "../boot-stage.js";

export class BootAgentsStage implements BootStage {
  readonly id = "agents";
  private stopped = false;

  async start(): Promise<void> {
    const builder = new AgentBuilder({
      preparedAgents: mapAgentInputs(currentRunScope().environment),
    });
    const agents = {
      [ScoutAgentRoles.Coordinator]: builder.buildCoordinator(),
      [ScoutAgentRoles.Researcher]: builder.buildWorker(ScoutAgentRoles.Researcher),
      [ScoutAgentRoles.Verifier]: builder.buildWorker(ScoutAgentRoles.Verifier),
      [ScoutAgentRoles.Validator]: builder.buildWorker(ScoutAgentRoles.Validator),
    } satisfies Record<ScoutAgentRole, ScoutAgent>;
    const settled = await Promise.allSettled(
      Object.values(agents).map((agent) => agent.start()),
    );
    const errors = settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      .map((entry) => entry.reason);
    if (errors.length === 0) return;
    this.stopRunners("agent_startup_failed");
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${errors.length} Scout agents failed to start.`);
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopRunners(reason);
  }

  private stopRunners(reason: string): void {
    const errors: unknown[] = [];
    for (const agent of currentRunScope().agentRegistry.listAgents()) {
      try {
        agent.runner?.stop(reason);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} Scout agent runners failed to stop.`);
    }
  }
}

function mapAgentInputs(environment: RunEnvironment): PreparedAgentInputs {
  return Object.fromEntries(
    Object.entries(environment.agents).map(([role, agent]) => [
      role,
      {
        agentMount: agent.mount,
        assetCommit: agent.assetCommit,
      },
    ]),
  ) as PreparedAgentInputs;
}

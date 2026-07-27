import { AgentBuilder } from "../../../agent/builder/agent-builder.js";
import type { ScoutAgent } from "../../../agent/core/scout-agent.js";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../../agent/thread/types.js";
import type { RunStage } from "../../lifecycle/index.js";
import { currentRunScope } from "../../run-scope.js";
import {
  projectRun,
  type RunProjection,
} from "../projection/index.js";

export class RestoreAgentsStage implements RunStage {
  readonly id = "restore_agents";
  private stopped = false;

  async start(): Promise<void> {
    const projection = projectRun(currentRunScope().journal.readAll());
    const builder = new AgentBuilder();
    const agents = {
      [ScoutAgentRoles.Coordinator]: builder.buildCoordinator(),
      [ScoutAgentRoles.Researcher]: builder.buildWorker(ScoutAgentRoles.Researcher),
      [ScoutAgentRoles.Verifier]: builder.buildWorker(ScoutAgentRoles.Verifier),
      [ScoutAgentRoles.Validator]: builder.buildWorker(ScoutAgentRoles.Validator),
    } satisfies Record<ScoutAgentRole, ScoutAgent>;
    const settled = await Promise.allSettled(
      Object.values(agents).map((agent) => this.restoreAgent(agent, projection)),
    );
    const errors = settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      .map((entry) => entry.reason);
    if (errors.length === 0) return;
    await this.stopAgents("agent_restore_failed");
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `${errors.length} Scout agents failed to restore.`);
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.stopAgents(reason);
  }

  private async restoreAgent(
    agent: ScoutAgent,
    projection: RunProjection,
  ): Promise<void> {
    const thread = projection.threads.find((candidate) =>
      candidate.agentId === agent.agentId
    );
    const agentTurns = projection.turns.filter((turn) =>
      turn.agentId === agent.agentId
    );
    const threadTurns = thread
      ? agentTurns.filter((turn) =>
          turn.threadId === thread.threadId
        )
      : [];
    const taskHasSteps = projection.tasks.some((task) =>
      task.agentId === agent.agentId && (task.steps?.length ?? 0) > 0
    );

    if (!thread || threadTurns.length === 0) {
      if (taskHasSteps || agentTurns.length > 0) {
        throw new Error(
          `Cannot restore agent ${agent.agentId} without matching resumable thread memory.`,
        );
      }
      await agent.startThread();
      return;
    }

    await agent.resumeThread({
      thread,
      invocationSequence: threadTurns.length,
    });
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

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentJsonValue } from "../../../../agent/tools/types.js";
import type { UnsubscribeEventHandler } from "../../../../core/events/index.js";
import { currentRunScope } from "../../../../run/run-scope.js";
import {
  RbtEvents,
  type RbtBehaviorRequest,
  type RbtBehaviorResult,
  type RbtCampaignCommandEvent,
  type RbtExecutionPlatform,
  type RbtHostCommandExecution,
} from "../../rbt-events.js";

interface CampaignHistoryCommand {
  sequence: number;
  input: AgentJsonValue;
  request: RbtBehaviorRequest;
  result?: RbtBehaviorResult;
  status: "completed" | "failed";
  error?: string;
  hostCommands: RbtHostCommandExecution[];
  startedAt: string;
  completedAt: string;
}

interface CampaignExecutionHistory {
  runtimeSequence: number;
  executeFileRef: string;
  campaignId: string;
  scenarioId: string;
  platform: RbtExecutionPlatform;
  startedAt: string;
  endedAt?: string;
  status: "recording" | "completed" | "failed";
  commands: CampaignHistoryCommand[];
  artifactPath: string;
}

/** Persists one runtime-owned JSON history for each RBT campaign execution. */
export class RbtCampaignExecutionHistoryStore {
  private readonly active = new Map<string, CampaignExecutionHistory>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(RbtEvents.campaign, async (event) => {
      if (RbtEvents.campaign.start.is(event)) {
        await this.recordStart(event.payload);
        return;
      }
      if (RbtEvents.campaign.command.is(event)) {
        await this.recordCommand(event.payload, false);
        return;
      }
      if (RbtEvents.campaign.end.is(event)) {
        await this.recordCommand(event.payload, true);
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.active.clear();
  }

  private async recordStart(command: RbtCampaignCommandEvent): Promise<void> {
    const key = historyKey(command.agentId, command.runtimeSequence);
    if (this.active.has(key)) {
      throw new Error(`RBT campaign history is already recording: ${command.campaignId}.`);
    }
    const scope = currentRunScope();
    const environment = scope.environment.agents[command.role];
    if (!environment) throw new Error(`RBT Agent environment is unavailable: ${command.role}.`);
    const artifactPath = join(
      resolve(environment.mount.artifactRoot),
      "history",
      `${String(command.runtimeSequence).padStart(3, "0")}.json`,
    );
    if (existsSync(artifactPath)) {
      throw new Error(`RBT campaign execution history already exists: ${artifactPath}.`);
    }
    const history: CampaignExecutionHistory = {
      runtimeSequence: command.runtimeSequence,
      executeFileRef: command.executeFileRef,
      campaignId: command.campaignId,
      scenarioId: command.scenarioId,
      platform: structuredClone(command.platform),
      startedAt: command.startedAt,
      ...(command.status === "failed" ? { endedAt: command.completedAt } : {}),
      status: command.status === "failed" ? "failed" : "recording",
      commands: [historyCommand(command)],
      artifactPath,
    };
    if (command.status !== "failed") this.active.set(key, history);
    this.write(history);
    if (command.status === "failed") await this.publishReady(command, history);
  }

  private async recordCommand(command: RbtCampaignCommandEvent, closesHistory: boolean): Promise<void> {
    const key = historyKey(command.agentId, command.runtimeSequence);
    const history = this.active.get(key);
    if (!history) {
      throw new Error(`RBT campaign history is not active: ${command.campaignId}.`);
    }
    if (history.executeFileRef !== command.executeFileRef) {
      throw new Error(`RBT campaign execute-file changed while recording: ${command.campaignId}.`);
    }
    history.commands.push(historyCommand(command));
    if (command.status === "failed") history.status = "failed";
    if (closesHistory) {
      if (history.status === "recording") history.status = "completed";
      history.endedAt = command.completedAt;
      this.active.delete(key);
    }
    this.write(history);
    if (closesHistory) await this.publishReady(command, history);
  }

  private write(history: CampaignExecutionHistory): void {
    mkdirSync(dirname(history.artifactPath), { recursive: true });
    const { artifactPath: _artifactPath, ...artifact } = history;
    writeFileSync(history.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }

  private async publishReady(
    command: RbtCampaignCommandEvent,
    history: CampaignExecutionHistory,
  ): Promise<void> {
    const scope = currentRunScope();
    if (history.status === "recording") {
      throw new Error(`RBT campaign history is still recording: ${history.campaignId}.`);
    }
    await scope.eventBus.publishAndWait(RbtEvents.history.ready, {
      executorHistoryRef: relative(scope.runRoot, history.artifactPath).split(sep).join("/"),
      executeFileRef: history.executeFileRef,
      runtimeSequence: history.runtimeSequence,
      campaignId: history.campaignId,
      scenarioId: history.scenarioId,
      status: history.status,
      agentId: command.agentId,
      role: command.role,
    }, { occurredAt: command.completedAt });
  }
}

function historyCommand(command: RbtCampaignCommandEvent): CampaignHistoryCommand {
  return {
    sequence: command.sequence,
    input: structuredClone(command.agentInput),
    request: structuredClone(command.request),
    ...(command.result ? { result: structuredClone(command.result) } : {}),
    status: command.status,
    ...(command.error ? { error: command.error } : {}),
    hostCommands: structuredClone(command.hostCommands),
    startedAt: command.startedAt,
    completedAt: command.completedAt,
  };
}

function historyKey(agentId: string, runtimeSequence: number): string {
  return `${agentId}\u0000${runtimeSequence}`;
}

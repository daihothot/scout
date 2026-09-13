import type { DynamicToolCallResponse } from "../../../agent-server/types.js";
import type { AgentJsonValue } from "../../../agent/tools/types.js";
import type { ScoutDomainDynamicToolCall } from "../../types.js";
import {
  RbtEvents,
  type RbtCampaignCommandEvent,
  type RbtExecutionPlatform,
} from "../rbt-events.js";
import { currentRunScope } from "../../../run/run-scope.js";
import {
  JarvisBehaviorToolStore,
  type JarvisBehaviorExecutionState,
} from "./jarvis-behavior-tool-store.js";
import type { BehaviorCommandExecution, JarvisBehaviorCommandRunner } from "./jarvis-behavior-command-runner.js";

export interface ExecuteFileCommand {
  command: string;
  payload: Record<string, AgentJsonValue>;
}

export interface ParsedExecuteFile extends JarvisBehaviorExecutionState {
  commands: ExecuteFileCommand[];
}

/** Owns execute-file sequencing, cleanup and campaign event publication. */
export class JarvisBehaviorExecuteFileRunner {
  constructor(
    private readonly commandRunner: JarvisBehaviorCommandRunner,
    private readonly store: JarvisBehaviorToolStore,
  ) {}

  async run(
    call: ScoutDomainDynamicToolCall,
    executeFile: ParsedExecuteFile,
    platform: RbtExecutionPlatform,
  ): Promise<DynamicToolCallResponse> {
    this.store.startExecution(call.caller.agentId, executeFile);
    let campaignStarted = false;
    let scenarioActive = false;
    let runtimeCommandFailed = false;
    let firstFailure: { sequence: number; command: string; code: string; message: string } | undefined;
    let executedCommands = 0;
    try {
      for (const [index, planned] of executeFile.commands.entries()) {
        if (runtimeCommandFailed) {
          if (planned.command === "behavior.scenario.deactivate" && !scenarioActive) continue;
          if (planned.command === "behavior.campaign.stop" && !campaignStarted) continue;
          if (planned.command !== "behavior.scenario.deactivate" && planned.command !== "behavior.campaign.stop") continue;
        }
        const sequence = index + 1;
        const command = await this.commandRunner.run(call, planned.command, planned.payload);
        executedCommands += 1;
        if (command.status === "completed") {
          if (planned.command === "behavior.campaign.start") campaignStarted = true;
          if (planned.command === "behavior.scenario.activate") scenarioActive = true;
          if (planned.command === "behavior.scenario.deactivate") scenarioActive = false;
          if (planned.command === "behavior.campaign.stop") campaignStarted = false;
        } else {
          runtimeCommandFailed = true;
          firstFailure ??= {
            sequence,
            command: planned.command,
            code: command.errorCode ?? "behavior_command_failed",
            message: command.error ?? "Behavioral command failed.",
          };
        }
        try {
          await this.publishCampaignCommand(call, executeFile, platform, sequence, planned, command);
        } catch (error) {
          firstFailure ??= {
            sequence,
            command: planned.command,
            code: "campaign_history_write_failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    } catch (error) {
      firstFailure ??= {
        sequence: executedCommands + 1,
        command: executeFile.commands[executedCommands]?.command ?? "unknown",
        code: "behavior_command_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.store.finishExecution(call.caller.agentId);
    }
    const output: AgentJsonValue = firstFailure
      ? { status: "failed", operation: "execute_file", executedCommands, error: firstFailure }
      : { status: "completed", operation: "execute_file", executedCommands };
    return dynamicResponse(firstFailure === undefined, output);
  }

  private async publishCampaignCommand(
    call: ScoutDomainDynamicToolCall,
    executeFile: ParsedExecuteFile,
    platform: RbtExecutionPlatform,
    sequence: number,
    agentInput: ExecuteFileCommand,
    command: BehaviorCommandExecution,
  ): Promise<void> {
    const scope = currentRunScope();
    const payload: RbtCampaignCommandEvent = {
      bddId: executeFile.bddId,
      targetVersion: executeFile.targetVersion,
      executeFileRef: executeFile.executeFileRef,
      runtimeSequence: executeFile.runtimeSequence,
      campaignId: executeFile.campaignId,
      scenarioId: executeFile.scenarioId,
      runId: scope.runId,
      sequence,
      agentId: call.caller.agentId,
      role: call.caller.role,
      callId: call.input.callId,
      platform,
      agentInput: toJsonValue(agentInput),
      request: command.request,
      ...(command.result ? { result: command.result } : {}),
      status: command.status,
      ...(command.error ? { error: command.error } : {}),
      hostCommands: command.hostCommands,
      startedAt: command.startedAt,
      completedAt: command.completedAt,
    };
    const eventType = agentInput.command === "behavior.campaign.start"
      ? RbtEvents.campaign.start
      : agentInput.command === "behavior.campaign.stop"
        ? RbtEvents.campaign.end
        : RbtEvents.campaign.command;
    await scope.eventBus.publishAndWait(eventType, payload, { occurredAt: command.completedAt });
  }
}

function dynamicResponse(success: boolean, output: AgentJsonValue): DynamicToolCallResponse {
  return { success, contentItems: [{ type: "inputText", text: JSON.stringify(output, null, 2) }] };
}

function toJsonValue(value: unknown): AgentJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
  }
  return String(value);
}

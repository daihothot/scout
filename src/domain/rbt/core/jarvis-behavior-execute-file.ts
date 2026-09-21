import type { DynamicToolCallResponse } from "../../../agent-server/types.js";
import type { AgentJsonValue } from "../../../agent/tools/types.js";
import type { ScoutDomainDynamicToolCall } from "../../types.js";
import type { ExecutionPlatformIdentity } from "../../../execution/index.js";
import {
  RbtEvents,
  type RbtCampaignCommandEvent,
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
    platform: ExecutionPlatformIdentity,
  ): Promise<DynamicToolCallResponse> {
    const preflight = await this.commandRunner.run(call, "behavior.registry.manifest", {});
    if (preflight.status !== "completed") {
      return dynamicResponse(false, {
        status: "failed",
        operation: "execute_file",
        executedCommands: 0,
        error: {
          sequence: 0,
          command: "behavior.registry.manifest",
          code: "identity_preflight_failed",
          message: preflight.error ?? "Behavior registry manifest is unavailable.",
        },
      });
    }
    const asRecord = (value: AgentJsonValue | undefined): Record<string, AgentJsonValue> | undefined =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, AgentJsonValue>
        : undefined;
    const asRecords = (value: AgentJsonValue | undefined): Array<Record<string, AgentJsonValue>> | undefined =>
      Array.isArray(value) && value.every((entry) => asRecord(entry) !== undefined)
        ? value as Array<Record<string, AgentJsonValue>>
        : undefined;
    const manifest = asRecord(asRecord(preflight.result?.payload)?.manifest);
    const nodes = asRecords(manifest?.nodes);
    const variants = asRecords(manifest?.variants);
    const sources = asRecords(manifest?.sources);
    const triggers = asRecords(manifest?.triggerCommands);
    if (!manifest || !nodes || !variants || !sources || !triggers) {
      return dynamicResponse(false, {
        status: "failed",
        operation: "execute_file",
        executedCommands: 0,
        error: {
          sequence: 0,
          command: "behavior.registry.manifest",
          code: "identity_preflight_failed",
          message: "Behavior registry manifest has an invalid shape.",
        },
      });
    }
    const nodeIds = new Set(nodes.map((node) => node.id).filter((id): id is string => typeof id === "string"));
    const variantIds = new Set(variants
      .filter((variant) => typeof variant.id === "string" && typeof variant.variantId === "string")
      .map((variant) => `${variant.id}\u0000${variant.variantId}`));
    const sourceIds = new Set(sources.map((source) => source.sourceId).filter((id): id is string => typeof id === "string"));
    const triggerById = new Map(triggers
      .filter((trigger) => typeof trigger.triggerCommandId === "string")
      .map((trigger) => [trigger.triggerCommandId as string, trigger]));
    const activate = executeFile.commands.find((entry) => entry.command === "behavior.scenario.activate")?.payload;
    const trigger = executeFile.commands.find((entry) => entry.command === "behavior.trigger.invoke")?.payload;
    const problems: string[] = [];
    const rootId = typeof activate?.rootId === "string" ? activate.rootId : "";
    if (!nodeIds.has(rootId)) problems.push(`rootId ${rootId} is not registered`);
    for (const activation of Array.isArray(activate?.activations) ? activate.activations : []) {
      const value = asRecord(activation);
      const id = typeof value?.id === "string" ? value.id : "";
      const variantId = typeof value?.variantId === "string" ? value.variantId : "";
      if (!nodeIds.has(id)) problems.push(`activation id ${id} is not registered`);
      if (!variantIds.has(`${id}\u0000${variantId}`)) problems.push(`variant ${id}/${variantId} is not registered`);
    }
    const capture = asRecord(activate?.evidenceCapture);
    for (const sourceId of Array.isArray(capture?.sources) ? capture.sources : []) {
      if (typeof sourceId === "string" && !sourceIds.has(sourceId)) problems.push(`sourceId ${sourceId} is not registered`);
    }
    for (const request of Array.isArray(capture?.captures) ? capture.captures : []) {
      const value = asRecord(request);
      const nodeId = typeof value?.nodeId === "string" ? value.nodeId : "";
      const sourceId = typeof value?.sourceId === "string" ? value.sourceId : "";
      if (!nodeIds.has(nodeId)) problems.push(`capture nodeId ${nodeId} is not registered`);
      if (!sourceIds.has(sourceId)) problems.push(`capture sourceId ${sourceId} is not registered`);
      if (typeof value?.variantId === "string" && !variantIds.has(`${nodeId}\u0000${value.variantId}`)) {
        problems.push(`capture variant ${nodeId}/${value.variantId} is not registered`);
      }
    }
    const triggerCommandId = typeof trigger?.triggerCommandId === "string" ? trigger.triggerCommandId : "";
    const triggerDescriptor = triggerById.get(triggerCommandId);
    if (!triggerDescriptor) problems.push(`triggerCommandId ${triggerCommandId} is not registered`);
    else if (triggerDescriptor.relatedBehaviorId !== rootId) {
      problems.push(`triggerCommandId ${triggerCommandId} belongs to ${String(triggerDescriptor.relatedBehaviorId)}, not rootId ${rootId}`);
    }
    if (problems.length > 0) {
      return dynamicResponse(false, {
        status: "failed",
        operation: "execute_file",
        executedCommands: 0,
        error: {
          sequence: 0,
          command: "behavior.registry.manifest",
          code: "identity_preflight_failed",
          message: problems.join("; "),
        },
      });
    }
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
    platform: ExecutionPlatformIdentity,
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

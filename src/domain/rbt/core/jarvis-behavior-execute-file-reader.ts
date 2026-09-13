import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentJsonValue } from "../../../agent/tools/types.js";
import { currentRunScope } from "../../../run/run-scope.js";
import type { ScoutDomainDynamicToolCall } from "../../types.js";
import type { JarvisBehaviorToolStore } from "./jarvis-behavior-tool-store.js";
import type { ExecuteFileCommand, ParsedExecuteFile } from "./jarvis-behavior-execute-file.js";

const EXECUTE_FILE_COMMANDS = new Set([
  "behavior.campaign.start",
  "behavior.scenario.activate",
  "behavior.evidence.capture",
  "behavior.trigger.invoke",
  "behavior.scenario.deactivate",
  "behavior.campaign.stop",
]);

/** Reads and validates an Agent-owned execute-file. */
export function readJarvisBehaviorExecuteFile(
  call: ScoutDomainDynamicToolCall,
  executeFileInput: string,
  store: JarvisBehaviorToolStore,
): ParsedExecuteFile {
  const environment = currentRunScope().environment.agents[call.caller.role];
  if (!environment) throw new Error(`RBT Agent environment is unavailable: ${call.caller.role}.`);
  const artifactRoot = resolve(environment.mount.artifactRoot);
  const executeFilePath = resolve(isAbsolute(executeFileInput) ? executeFileInput : join(artifactRoot, executeFileInput));
  const artifactRelative = relative(artifactRoot, executeFilePath);
  if (artifactRelative.length === 0
    || artifactRelative.startsWith(`..${sep}`)
    || artifactRelative === ".."
    || isAbsolute(artifactRelative)) {
    throw new Error("execute_file must stay inside the calling Agent artifact root.");
  }
  const pathParts = artifactRelative.split(sep);
  if (pathParts.length !== 3 || pathParts[2] !== "execute-file.json") {
    throw new Error("execute_file must use <bdd-id>/<version>/execute-file.json under the calling Agent artifact root.");
  }
  const [bddId, targetVersion] = pathParts;
  if (!bddId || !targetVersion) throw new Error("execute_file path has an empty BDD or version segment.");

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(executeFilePath, "utf8"));
  } catch (error) {
    throw new Error(`execute_file is not readable JSON: ${String(error)}`);
  }
  const file = requireObject(value, "execute-file.json");
  const unexpectedKeys = Object.keys(file).filter((key) => key !== "commands");
  if (unexpectedKeys.length > 0) throw new Error(`execute-file.json contains unsupported fields: ${unexpectedKeys.join(", ")}.`);
  if (!Array.isArray(file.commands)) throw new Error("execute-file.json commands must be an array.");
  const commands = file.commands.map((entry, index) => {
    const command = requireObject(entry, `execute-file.json commands[${index}]`);
    if (Object.keys(command).some((key) => key !== "command" && key !== "payload")) {
      throw new Error(`execute-file.json commands[${index}] contains unsupported fields.`);
    }
    if (typeof command.command !== "string" || !EXECUTE_FILE_COMMANDS.has(command.command)) {
      throw new Error(`execute-file.json commands[${index}].command is not supported.`);
    }
    return {
      command: command.command,
      payload: toJsonObject(requireObject(command.payload, `execute-file.json commands[${index}].payload`)),
    };
  });
  validateExecuteSequence(commands);

  const startPayload = commands[0]?.payload ?? {};
  const campaignId = requiredPayloadString(startPayload, "behavior.campaign.start", "campaignId");
  const scenarioId = requiredPayloadString(startPayload, "behavior.campaign.start", "scenarioId");
  if (campaignId.includes("${SCOUT_RUN_ID}") || scenarioId.includes("${SCOUT_RUN_ID}")) {
    throw new Error("campaignId and scenarioId must not contain SCOUT_RUN_ID.");
  }
  validateExecuteIdentities(commands, campaignId, scenarioId);
  const historyRoot = join(artifactRoot, "history");
  const existingMaximum = existsSync(historyRoot)
    ? readdirSync(historyRoot).reduce((maximum, name) => {
        const match = /^(\d+)\.json$/.exec(name);
        return match ? Math.max(maximum, Number(match[1])) : maximum;
      }, 0)
    : 0;
  return {
    executeFilePath,
    executeFileRef: artifactRelative.split(sep).join("/"),
    bddId,
    targetVersion,
    runtimeSequence: store.nextRuntimeSequence(call.caller.agentId, existingMaximum),
    campaignId,
    scenarioId,
    commands,
  };
}

function validateExecuteSequence(commands: ExecuteFileCommand[]): void {
  if (commands.length === 0) throw new Error("execute-file.json commands must not be empty.");
  if (commands[0]?.command !== "behavior.campaign.start") throw new Error("execute-file.json must start with behavior.campaign.start.");
  if (commands.at(-1)?.command !== "behavior.campaign.stop") throw new Error("execute-file.json must end with behavior.campaign.stop.");
  const count = (command: string) => commands.filter((entry) => entry.command === command).length;
  if (count("behavior.campaign.start") !== 1
    || count("behavior.scenario.activate") !== 1
    || count("behavior.trigger.invoke") !== 1
    || count("behavior.scenario.deactivate") !== 1
    || count("behavior.campaign.stop") !== 1) {
    throw new Error("execute-file.json requires exactly one campaign.start, scenario.activate, trigger.invoke, scenario.deactivate, and campaign.stop.");
  }
  const activate = commands.findIndex((entry) => entry.command === "behavior.scenario.activate");
  const trigger = commands.findIndex((entry) => entry.command === "behavior.trigger.invoke");
  const deactivate = commands.findIndex((entry) => entry.command === "behavior.scenario.deactivate");
  if (!(activate < trigger && trigger < deactivate)) throw new Error("execute-file.json Scenario activation, trigger, and cleanup order is invalid.");
}

function validateExecuteIdentities(commands: ExecuteFileCommand[], campaignId: string, scenarioId: string): void {
  for (const command of commands) {
    switch (command.command) {
      case "behavior.campaign.start":
        requiredPayloadString(command.payload, command.command, "campaignId");
        requiredPayloadString(command.payload, command.command, "scenarioId");
        break;
      case "behavior.scenario.activate":
        requiredPayloadString(command.payload, command.command, "scenarioId");
        requiredPayloadString(command.payload, command.command, "rootId");
        validateActivations(command.payload, command.command);
        validateEvidenceCapture(command.payload, command.command);
        break;
      case "behavior.evidence.capture":
        requiredPayloadString(command.payload, command.command, "campaignId");
        requiredPayloadString(command.payload, command.command, "captureId");
        break;
      case "behavior.trigger.invoke":
        requiredPayloadString(command.payload, command.command, "scenarioId");
        requiredPayloadString(command.payload, command.command, "triggerCommandId");
        break;
      case "behavior.scenario.deactivate":
        requiredPayloadString(command.payload, command.command, "scenarioId");
        break;
      case "behavior.campaign.stop":
        requiredPayloadString(command.payload, command.command, "campaignId");
        break;
    }
    const commandCampaignId = optionalPayloadString(command.payload, command.command, "campaignId");
    if (commandCampaignId && commandCampaignId !== campaignId) throw new Error(`${command.command} payload.campaignId does not match campaign.start.`);
    const commandScenarioId = optionalPayloadString(command.payload, command.command, "scenarioId");
    if (commandScenarioId && commandScenarioId !== scenarioId) throw new Error(`${command.command} payload.scenarioId does not match campaign.start.`);
  }
}

function validateActivations(payload: Record<string, AgentJsonValue>, command: string): void {
  const activations = payload.activations;
  if (activations === undefined) return;
  if (!Array.isArray(activations)) throw new Error(`${command} payload.activations must be an array.`);
  activations.forEach((activation, index) => {
    if (!isRecord(activation)) throw new Error(`${command} payload.activations[${index}] must be an object.`);
    requiredPayloadString(activation as Record<string, AgentJsonValue>, command, "id");
    requiredPayloadString(activation as Record<string, AgentJsonValue>, command, "variantId");
  });
}

function validateEvidenceCapture(payload: Record<string, AgentJsonValue>, command: string): void {
  const evidenceCapture = payload.evidenceCapture;
  if (evidenceCapture === undefined) return;
  if (!isRecord(evidenceCapture)) {
    throw new Error(`${command} payload.evidenceCapture must be an object.`);
  }
  const allowedKeys = new Set(["enabled", "kinds", "sources", "captures"]);
  const unsupported = Object.keys(evidenceCapture).filter((key) => !allowedKeys.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${command} payload.evidenceCapture contains unsupported fields: ${unsupported.join(", ")}.`);
  }
  if (evidenceCapture.enabled !== undefined && typeof evidenceCapture.enabled !== "boolean") {
    throw new Error(`${command} payload.evidenceCapture.enabled must be a boolean.`);
  }
  const captures = evidenceCapture.captures;
  if (captures === undefined) return;
  if (!Array.isArray(captures)) {
    throw new Error(`${command} payload.evidenceCapture.captures must be an array.`);
  }
  captures.forEach((capture, index) => {
    if (!isRecord(capture)) {
      throw new Error(`${command} payload.evidenceCapture.captures[${index}] must be an object.`);
    }
    const captureRecord = capture as Record<string, AgentJsonValue>;
    for (const field of ["captureId", "sourceId", "kind"]) {
      const value = captureRecord[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${command} payload.evidenceCapture.captures[${index}].${field} must be a non-empty string.`);
      }
    }
  });
}

function requiredPayloadString(payload: Record<string, AgentJsonValue>, command: string, field: string): string {
  const value = optionalPayloadString(payload, command, field);
  if (!value) throw new Error(`${command} payload.${field} must be a non-empty string.`);
  return value;
}

function optionalPayloadString(payload: Record<string, AgentJsonValue>, command: string, field: string): string | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${command} payload.${field} must be a non-empty string.`);
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function toJsonObject(value: Record<string, unknown>): Record<string, AgentJsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
}

function toJsonValue(value: unknown): AgentJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) return toJsonObject(value);
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

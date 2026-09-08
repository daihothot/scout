import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentCommandExecutionObservedEvent } from "../../agent/command-execution/command-execution-events.js";
import { AgentEvents } from "../../agent/events/index.js";
import { agent } from "../../agent/context/agent-attachments.js";
import type { RunJournalEvent } from "../../run/journal/index.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import { resolveSynthesisRole } from "../../core/workflow/index.js";
import { RbtEvents, type RbtCampaignArtifactPublishedEvent } from "./rbt-events.js";

interface ParsedJarvisCommand {
  request?: Record<string, unknown>;
  behaviorType?: string;
  campaignId?: string;
  correlationId?: string;
}

interface ShellOperator {
  kind: "operator";
  value: ";" | "&&" | "||";
}

type ShellToken = string | ShellOperator;

interface CampaignCommandRecord {
  observation: AgentCommandExecutionObservedEvent;
  parsed: ParsedJarvisCommand;
  result?: unknown;
  resultRaw?: string;
  outputRemainder?: string;
}

interface CampaignRecording {
  campaignId: string;
  role: string;
  agentId: string;
  taskId?: string;
  startedAt: string;
  endedAt?: string;
  commands: CampaignCommandRecord[];
  conflicts: string[];
  finalized: boolean;
  artifactPath: string;
  artifactRef: string;
}

/** Records Executor Jarvis commands between campaign start and stop. */
export class ExecutorCampaignRecorder {
  private readonly activeByRole = new Map<string, CampaignRecording>();
  private readonly recordingsByCampaign = new Map<string, CampaignRecording>();
  private readonly publishedByCampaign = new Map<string, RbtCampaignArtifactPublishedEvent>();
  private readonly pendingNotifications = new Set<string>();

  async consume(
    observation: AgentCommandExecutionObservedEvent,
    options: { publishFinalization: boolean },
  ): Promise<void> {
    if (!this.isExecutorRole(observation.role)) return;
    const parsedCommands = parseJarvisCommands(observation.command);
    if (!parsedCommands) return;
    const extractedResults = extractResults(observation.aggregatedOutput);

    for (const [index, parsed] of parsedCommands.entries()) {
      let recording = this.activeByRole.get(observation.role);
      if (!recording
        && parsed.behaviorType === "behavior.campaign.start"
        && parsed.campaignId) {
        if (this.recordingsByCampaign.has(parsed.campaignId)) continue;
        recording = this.createRecording(observation, parsed.campaignId);
        this.activeByRole.set(observation.role, recording);
        this.recordingsByCampaign.set(recording.campaignId, recording);
      }
      if (!recording) continue;

      if (parsed.behaviorType === "behavior.campaign.start"
        && parsed.campaignId
        && parsed.campaignId !== recording.campaignId) {
        recording.conflicts.push(
          `忽略嵌套启动的 Campaign ${parsed.campaignId}；当前 Campaign ${recording.campaignId} 仍处于活动状态。`,
        );
      }

      const extracted = extractedResults[index];
      recording.commands.push(buildCommandRecord(observation, parsed, extracted));
      const closesRecording = parsed.behaviorType === "behavior.campaign.stop"
        && parsed.campaignId === recording.campaignId
        && observationSucceeded(observation, extracted?.result);
      if (closesRecording) {
        recording.finalized = true;
        recording.endedAt = observation.observedAt;
        this.activeByRole.delete(observation.role);
      }
      this.writeArtifact(recording);
      if (closesRecording && options.publishFinalization) {
        await this.publishFinalization(recording);
      }
    }
  }

  async restore(events: RunJournalEvent[]): Promise<void> {
    this.activeByRole.clear();
    this.recordingsByCampaign.clear();
    this.publishedByCampaign.clear();
    this.pendingNotifications.clear();

    for (const event of events) {
      if (RbtEvents.campaign.artifactPublished.is(event)) {
        this.publishedByCampaign.set(event.payload.campaignId, structuredClone(event.payload));
      }
    }
    for (const event of events) {
      if (AgentEvents.commandExecution.observed.is(event)) {
        await this.consume(event.payload, { publishFinalization: false });
      }
    }

    for (const recording of this.recordingsByCampaign.values()) {
      if (!recording.finalized) continue;
      const published = this.publishedByCampaign.get(recording.campaignId);
      if (!published) {
        await this.publishFinalization(recording);
        continue;
      }
      const digest = digestFile(recording.artifactPath);
      if (digest !== published.digest) {
        throw new Error(
          `RBT campaign artifact digest changed during restore: ${recording.artifactRef}.`,
        );
      }
    }
  }

  async flushNotifications(): Promise<void> {
    const scope = currentRunScope();
    const coordinatorRole = resolveSynthesisRole(scope.scheduler.snapshot()).name;
    const coordinator = scope.agentRegistry.findAgent(coordinatorRole);
    if (!coordinator) return;

    for (const campaignId of [...this.pendingNotifications]) {
      const fact = this.publishedByCampaign.get(campaignId);
      if (!fact) continue;
      const result = await coordinator.sendMessage({
        message: agent.turn.message([
          "Scout Runtime finalized an RBT campaign artifact.",
          `runtime_campaign_identity: ${fact.campaignId}`,
          `runtime_campaign_artifact_ref: ${fact.ref}`,
          `executor_role: ${fact.role}`,
          `executor_task_id: ${fact.taskId ?? "none"}`,
          `command_count: ${fact.commandCount}`,
          `status: ${fact.status}`,
        ].join("\n")),
        deliveryMode: "queued",
        delivery: {
          messageId: campaignMessageId(campaignId),
          queuedAt: fact.publishedAt,
        },
      });
      if (result.ok) this.pendingNotifications.delete(campaignId);
    }
  }

  private isExecutorRole(role: string): boolean {
    return currentRunScope().scheduler.snapshot().roles.some((candidate) =>
      candidate.name === role && candidate.phases.includes("execute")
    );
  }

  private createRecording(
    observation: AgentCommandExecutionObservedEvent,
    campaignId: string,
  ): CampaignRecording {
    const scope = currentRunScope();
    const agentEnvironment = scope.environment.agents[observation.role];
    if (!agentEnvironment) {
      throw new Error(`RBT Executor environment is unavailable: ${observation.role}.`);
    }
    const artifactPath = join(
      resolve(agentEnvironment.mount.artifactRoot),
      "campaigns",
      campaignFileName(campaignId),
    );
    return {
      campaignId,
      role: observation.role,
      agentId: observation.agentId,
      ...(observation.taskId ? { taskId: observation.taskId } : {}),
      startedAt: observation.observedAt,
      commands: [],
      conflicts: [],
      finalized: false,
      artifactPath,
      artifactRef: relative(resolve(scope.runRoot), artifactPath).split(sep).join("/"),
    };
  }

  private writeArtifact(recording: CampaignRecording): void {
    mkdirSync(dirname(recording.artifactPath), { recursive: true });
    writeFileSync(recording.artifactPath, renderCampaign(recording), "utf8");
  }

  private async publishFinalization(recording: CampaignRecording): Promise<void> {
    if (!recording.endedAt) {
      throw new Error(`Finalized RBT campaign has no end time: ${recording.campaignId}.`);
    }
    const existing = this.publishedByCampaign.get(recording.campaignId);
    if (existing) {
      this.pendingNotifications.add(recording.campaignId);
      await this.flushNotifications();
      return;
    }
    const publishedAt = recording.endedAt;
    const payload: RbtCampaignArtifactPublishedEvent = {
      artifactId: `rbt-campaign:${recording.campaignId}`,
      campaignId: recording.campaignId,
      ...(recording.taskId ? { taskId: recording.taskId } : {}),
      agentId: recording.agentId,
      role: recording.role,
      ref: recording.artifactRef,
      digest: digestFile(recording.artifactPath),
      status: "finalized",
      commandCount: recording.commands.length,
      startedAt: recording.startedAt,
      endedAt: recording.endedAt,
      publishedAt,
    };
    await currentRunScope().eventBus.publishAndWait(
      RbtEvents.campaign.artifactPublished,
      payload,
      { occurredAt: publishedAt },
    );
    this.publishedByCampaign.set(recording.campaignId, payload);
    this.pendingNotifications.add(recording.campaignId);
    await this.flushNotifications();
  }
}

function parseJarvisCommands(command: string): ParsedJarvisCommand[] | undefined {
  const outerWords = shellWords(command, {}, false);
  const scripts: string[] = [];
  for (const [index, word] of outerWords.entries()) {
    if (typeof word !== "string" || (word !== "-c" && word !== "-lc")) continue;
    const script = outerWords[index + 1];
    if (typeof script === "string") scripts.push(script);
  }
  if (scripts.length === 0) scripts.push(command);

  const parsed: ParsedJarvisCommand[] = [];
  for (const script of scripts) {
    parsed.push(...parseJarvisScript(script));
  }
  return parsed.length > 0 ? parsed : undefined;
}

function parseJarvisScript(script: string): ParsedJarvisCommand[] {
  const variables: Record<string, string> = {};
  const words = shellWords(script, variables, false);
  const parsed: ParsedJarvisCommand[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (typeof word !== "string") continue;
    const expandedWord = expandShellVariables(word, variables);
    const assignment = expandedWord.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (assignment) {
      variables[assignment[1]] = assignment[2];
      continue;
    }
    if (basename(word) !== "jarvis"
      || words[index + 1] !== "ws"
      || words[index + 2] !== "schema"
      || words[index + 3] !== "call"
      || words[index + 4] !== "behavior-control") continue;

    const callEnd = words.findIndex((candidate, candidateIndex) =>
      candidateIndex > index + 4 && typeof candidate !== "string"
    );
    const end = callEnd < 0 ? words.length : callEnd;
    const paramsIndex = words.findIndex((candidate, candidateIndex) =>
      candidateIndex > index + 4
      && candidateIndex < end
      && candidate === "--params-json"
    );
    if (paramsIndex < 0 || paramsIndex + 1 >= end) {
      parsed.push({});
      continue;
    }
    const rawParams = words[paramsIndex + 1];
    if (typeof rawParams !== "string") {
      parsed.push({});
      continue;
    }
    parsed.push(parseBehaviorRequest(expandShellVariables(rawParams, variables)));
    index = paramsIndex + 1;
  }
  return parsed;
}

function expandShellVariables(
  word: string,
  variables: Record<string, string>,
): string {
  return word.replace(/\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, bracedName: string | undefined, plainName: string | undefined) =>
      variables[bracedName ?? plainName ?? ""] ?? "",
  );
}

function parseBehaviorRequest(params: string): ParsedJarvisCommand {
  let request: unknown;
  try {
    request = JSON.parse(params);
  } catch {
    return {};
  }
  if (!isRecord(request)) return {};
  const payload = isRecord(request.payload) ? request.payload : undefined;
  return {
    request,
    ...(typeof request.type === "string" ? { behaviorType: request.type } : {}),
    ...(typeof payload?.campaignId === "string" ? { campaignId: payload.campaignId } : {}),
    ...(typeof request.correlationId === "string"
      ? { correlationId: request.correlationId }
      : {}),
  };
}

function shellWords(
  command: string,
  variables: Record<string, string>,
  expandVariables: boolean,
): ShellToken[] {
  const words: ShellToken[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const push = (): void => {
    if (!started) return;
    words.push(current);
    current = "";
    started = false;
  };
  const appendVariable = (index: { value: number }): void => {
    const start = index.value;
    let end = start + 1;
    let name = "";
    if (command[end] === "{") {
      end += 1;
      const nameStart = end;
      while (end < command.length && /[A-Za-z0-9_]/.test(command[end] ?? "")) end += 1;
      if (command[end] === "}") {
        name = command.slice(nameStart, end);
        index.value = end;
      } else {
        current += "$";
        return;
      }
    } else {
      while (end < command.length && /[A-Za-z0-9_]/.test(command[end] ?? "")) end += 1;
      if (end === start + 1) {
        current += "$";
        return;
      }
      name = command.slice(start + 1, end);
      index.value = end - 1;
    }
    current += variables[name] ?? "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
        continue;
      }
      started = true;
      if (character === "\\" && quote === '"') {
        const next = command[index + 1];
        if (next === "\\" || next === '"' || next === "$" || next === "`") {
          current += next;
          index += 1;
          continue;
        }
      }
      if (character === "$" && expandVariables && quote === '"') {
        const variableIndex = { value: index };
        appendVariable(variableIndex);
        index = variableIndex.value;
        continue;
      }
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      started = true;
      const next = command[index + 1];
      if (next !== undefined) {
        current += next;
        index += 1;
      } else {
        current += "\\";
      }
      continue;
    }
    if (character === "$" && expandVariables) {
      started = true;
      const variableIndex = { value: index };
      appendVariable(variableIndex);
      index = variableIndex.value;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    if (character === ";") {
      push();
      words.push({ kind: "operator", value: ";" });
      continue;
    }
    if (character === "&" && command[index + 1] === "&") {
      push();
      words.push({ kind: "operator", value: "&&" });
      index += 1;
      continue;
    }
    if (character === "|" && command[index + 1] === "|") {
      push();
      words.push({ kind: "operator", value: "||" });
      index += 1;
      continue;
    }
    started = true;
    current += character;
  }
  push();
  return words;
}

function buildCommandRecord(
  observation: AgentCommandExecutionObservedEvent,
  parsed: ParsedJarvisCommand,
  extracted?: ExtractedResult,
): CampaignCommandRecord {
  return {
    observation: structuredClone(observation),
    parsed: structuredClone(parsed),
    ...(extracted?.result === undefined ? {} : { result: extracted.result }),
    ...(extracted?.resultRaw === undefined ? {} : { resultRaw: extracted.resultRaw }),
    ...(extracted?.remainder === undefined ? {} : { outputRemainder: extracted.remainder }),
  };
}

interface ExtractedResult {
  result?: unknown;
  resultRaw?: string;
  remainder?: string;
}

function extractResults(output: string | null | undefined): ExtractedResult[] {
  if (!output) return [];
  const marker = "[RESULT]";
  const matches = [...output.matchAll(/\[RESULT\]/g)];
  if (matches.length === 0) {
    const remainder = output.trim();
    return remainder ? [{ remainder }] : [];
  }
  return matches.map((match, index) => {
    const markerIndex = match.index ?? 0;
    const nextIndex = matches[index + 1]?.index ?? output.length;
    const before = index === 0 ? output.slice(0, markerIndex).trim() : "";
    const raw = output.slice(markerIndex + marker.length, nextIndex).trim();
    try {
      return {
        result: JSON.parse(raw),
        ...(before ? { remainder: before } : {}),
      };
    } catch {
      return {
        resultRaw: raw,
        ...(before ? { remainder: before } : {}),
      };
    }
  });
}

function observationSucceeded(
  observation: AgentCommandExecutionObservedEvent,
  result: unknown,
): boolean {
  const status = observation.status.toLowerCase();
  if (!["completed", "succeeded", "success", "ok"].includes(status)) return false;
  if (observation.exitCode !== undefined
    && observation.exitCode !== null
    && observation.exitCode !== 0) return false;
  if (!isRecord(result)) return true;
  if (result.ok === false || result.success === false) return false;
  const resultStatus = typeof result.status === "string" ? result.status.toLowerCase() : undefined;
  return !resultStatus || !["error", "failed", "failure"].includes(resultStatus);
}

function renderCampaign(recording: CampaignRecording): string {
  const lines = [
    `# RBT Campaign 记录：${recording.campaignId}`,
    "",
    "本文档由 Scout Runtime 按实际命令观察结果生成；原始命令、请求和返回值保持原样。",
    "",
    "## Campaign 概要",
    "",
    `- campaign_id: ${recording.campaignId}`,
    `- executor_role: ${recording.role}`,
    `- executor_agent_id: ${recording.agentId}`,
    `- executor_task_id: ${recording.taskId ?? "none"}`,
    `- status: ${recording.finalized ? "finalized" : "recording"}`,
    `- started_at: ${recording.startedAt}`,
    `- ended_at: ${recording.endedAt ?? "none"}`,
    `- command_count: ${recording.commands.length}`,
    "",
  ];
  if (recording.conflicts.length > 0) {
    lines.push("## 记录冲突", "");
    for (const conflict of recording.conflicts) lines.push(`- ${conflict}`);
    lines.push("");
  }
  lines.push("## 命令记录", "");
  recording.commands.forEach((record, index) => {
    const label = record.parsed.behaviorType ?? "jarvis command";
    const observation = record.observation;
    lines.push(
      `### ${index + 1}. ${label}`,
      "",
      `- observed_at: ${observation.observedAt}`,
      `- item_id: ${observation.itemId}`,
      `- correlation_id: ${record.parsed.correlationId ?? "none"}`,
      `- status: ${observation.status}`,
      `- exit_code: ${observation.exitCode ?? "none"}`,
      `- duration_ms: ${observation.durationMs ?? "none"}`,
      "",
    );
    if (record.parsed.request) {
      lines.push("#### 请求", "", "```json", prettyJson(record.parsed.request), "```", "");
    }
    lines.push("#### 原始命令", "", "```sh", observation.command, "```", "");
    if (record.result !== undefined) {
      lines.push("#### 返回值", "", "```json", prettyJson(record.result), "```", "");
    } else if (record.resultRaw) {
      lines.push("#### 返回值（无法解析）", "", "```text", record.resultRaw, "```", "");
    }
    if (record.outputRemainder) {
      lines.push("#### 命令输出", "", "```text", record.outputRemainder, "```", "");
    }
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function campaignFileName(campaignId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(campaignId)) return `${campaignId}.md`;
  const encoded = encodeURIComponent(campaignId).replaceAll(".", "%2E");
  return `${encoded}.md`;
}

function campaignMessageId(campaignId: string): string {
  return `rbt-campaign-${createHash("sha256").update(campaignId).digest("hex").slice(0, 24)}-finalized`;
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

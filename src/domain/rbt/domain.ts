import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ScoutAgentRole } from "../../agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../../agent/tools/types.js";
import type { DynamicToolCallResponse } from "../../agent-server/types.js";
import { resolveShellToolCommand } from "../../asset-store/files/command-resolution.js";
import { AgentEvents } from "../../agent/events/index.js";
import {
  EventSubscriptionPriorities,
  type UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import type {
  ScoutDomain,
  ScoutDomainDynamicToolCall,
  ScoutDomainJournalProjection,
} from "../types.js";
import { ExecutorCampaignRecorder } from "./executor-campaign-recorder.js";
import { RbtEvents } from "./rbt-events.js";

/** Owns Runtime Behavioral Test campaign transcripts and their recovery facts. */
export class RbtDomain implements ScoutDomain {
  readonly domainId = "rbt";
  readonly name = "Scout Runtime Behavioral Test Domain";
  readonly journal: ScoutDomainJournalProjection = rbtJournalProjection;
  private readonly recorder = new ExecutorCampaignRecorder();
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];

  dynamicToolsForRole(role: ScoutAgentRole): AgentDynamicToolSpec[] {
    if (!this.isExecutorRole(role)) return [];
    return [{
      guidanceSkill: "tool-unity-pipeline-cli",
      namespace: "rbt_unity_pipeline",
      name: "UnityPipeline",
      description: "通过 Scout Runtime 在宿主侧发现唯一 Unity Editor，并控制其 Play Mode。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: [
              "version",
              "status",
              "list",
              "editor_play",
              "editor_status",
              "editor_stop",
            ],
            description: "要执行的 Unity Pipeline CLI 操作。",
          },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: 120,
            description: "editor_* 操作的 CLI timeout；默认 30 秒。",
          },
        },
        required: ["operation"],
      },
    }];
  }

  handleDynamicToolCall(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse | undefined> | DynamicToolCallResponse | undefined {
    if (call.input.namespace !== "rbt_unity_pipeline" || call.input.tool !== "UnityPipeline") {
      return undefined;
    }
    const failure = (message: string, detail?: Record<string, unknown>): DynamicToolCallResponse => ({
      success: false,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({ status: "failed", message, ...detail }, null, 2),
      }],
    });
    if (!this.isExecutorRole(call.caller.role)) {
      return failure("UnityPipeline is only available to an RBT execute role.");
    }
    const rawInput = call.input.arguments;
    if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
      return failure("UnityPipeline arguments must be an object.");
    }
    const input = rawInput as Record<string, unknown>;
    const operation = input.operation;
    const supportedOperations = new Set([
      "version",
      "status",
      "list",
      "editor_play",
      "editor_status",
      "editor_stop",
    ]);
    if (typeof operation !== "string" || !supportedOperations.has(operation)) {
      return failure("Unsupported UnityPipeline operation.", { operation });
    }
    const timeoutSeconds = input.timeout_seconds ?? 30;
    if (
      typeof timeoutSeconds !== "number"
      || !Number.isInteger(timeoutSeconds)
      || timeoutSeconds < 1
      || timeoutSeconds > 120
    ) {
      return failure("timeout_seconds must be an integer between 1 and 120.");
    }
    const unexpectedKeys = Object.keys(input).filter((key) =>
      key !== "operation" && key !== "timeout_seconds"
    );
    if (unexpectedKeys.length > 0) {
      return failure("UnityPipeline arguments contain unsupported fields.", {
        fields: unexpectedKeys,
      });
    }

    const scope = currentRunScope();
    const agentEnvironment = scope.environment.agents[call.caller.role];
    const unityTool = agentEnvironment?.mount.shellTools.find((tool) => tool.id === "unity");
    if (!unityTool) {
      return failure("The current RBT execute role does not mount the unity CLI contract.");
    }
    const command = resolveShellToolCommand(
      unityTool,
      join(scope.scoutRoot, "assets", "codex"),
    );
    if (!command) {
      return failure("The unity CLI executable cannot be resolved by Scout Runtime.");
    }
    const operationArgs = operation === "version"
      ? ["--version"]
      : operation === "status" || operation === "list"
        ? ["--json", "--non-interactive", operation]
        : [
          "--json",
          "--non-interactive",
          "command",
          "--timeout",
          String(timeoutSeconds),
          operation,
        ];
    const args = [...(unityTool.args ?? []), ...operationArgs];

    return new Promise((resolveResponse) => {
      execFile(command, args, {
        cwd: scope.scoutRoot,
        env: process.env,
        timeout: (timeoutSeconds + 5) * 1_000,
        maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === "number" ? error.code : error ? null : 0;
        const status = error?.killed ? "timed_out" : error ? "failed" : "completed";
        const result = {
          operation,
          status,
          exitCode,
          stdout,
          stderr,
        };
        resolveResponse({
          success: error === null,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify(result, null, 2),
          }],
        });
      });
    });
  }

  async start(): Promise<void> {
    if (this.unsubscribers.length > 0) return;
    const scope = currentRunScope();
    this.unsubscribers.push(
      scope.eventBus.subscribe(AgentEvents.commandExecution.observed, async (event) => {
        if (!AgentEvents.commandExecution.observed.is(event)) return;
        try {
          await this.recorder.consume(event.payload, { publishFinalization: true });
        } catch (error) {
          scope.logger.error({
            module: "domain.rbt",
            event: "campaign_recording_failed",
            message: "Failed to record an RBT campaign command.",
            agentId: event.payload.agentId,
            taskId: event.payload.taskId,
            data: {
              itemId: event.payload.itemId,
              error: error instanceof Error ? error.stack ?? error.message : String(error),
            },
          });
        }
      }, { priority: EventSubscriptionPriorities.Normal }),
      scope.eventBus.subscribe(AgentEvents.thread, () => this.recorder.flushNotifications(), {
        priority: EventSubscriptionPriorities.Normal,
      }),
    );
  }

  async restore(): Promise<void> {
    await this.recorder.restore(currentRunScope().journal.readAll());
  }

  async stop(): Promise<void> {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
  }

  private isExecutorRole(role: ScoutAgentRole): boolean {
    return currentRunScope().scheduler.snapshot().roles.some((candidate) =>
      candidate.name === role && candidate.phases.includes("execute")
    );
  }
}

/** Projects finalized RBT campaign artifacts into the shared run projection. */
export const rbtJournalProjection: ScoutDomainJournalProjection = {
  eventTypes: [RbtEvents.campaign.artifactPublished],
  project(event) {
    if (!RbtEvents.campaign.artifactPublished.is(event)) return undefined;
    return {
      kind: "artifact",
      payload: {
        artifactId: event.payload.artifactId,
        ...(event.payload.taskId ? { taskId: event.payload.taskId } : {}),
        agentId: event.payload.agentId,
        role: event.payload.role,
        ref: event.payload.ref,
        digest: event.payload.digest,
        status: event.payload.status,
        publishedAt: event.payload.publishedAt,
      },
    };
  },
};

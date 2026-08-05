import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ScoutEvent,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { isPathWithin } from "../../core/path.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import {
  roleAgentInstructionAssetPaths,
  workerRoleInstructionAssetPaths,
} from "../roles/instructions.js";
import type {
  AgentThreadResumeRecord,
  AgentThreadSnapshot,
  ScoutAgentRole,
} from "../thread/types.js";
import { ScoutAgentRoles } from "../thread/types.js";

export class AgentThreadRecorder {
  private readonly threadLoggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(
      AgentEvents.thread,
      (event) => this.record(event),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.threadLoggers.clear();
  }

  private record(event: ScoutEvent): void {
    if (AgentEvents.thread.started.is(event)) {
      const thread = event.payload;
      this.write(event, thread.agentId, {
        ...thread,
        startInput: summarizeThreadStartInput(
          thread.agentId,
          thread.role,
          thread.startInput,
        ),
        startResponse: summarizeThreadResponse(thread.agentId, thread.startResponse),
      });
      return;
    }
    if (AgentEvents.thread.resumed.is(event)) {
      const resumed = event.payload;
      this.write(event, resumed.agentId, {
        ...resumed,
        resumeInput: summarizeThreadResumeInput(
          resumed.agentId,
          resumed.role,
          resumed.resumeInput,
        ),
        resumeResponse: summarizeThreadResponse(resumed.agentId, resumed.resumeResponse),
      });
      return;
    }
    if (AgentEvents.thread.closed.is(event)) {
      const thread = event.payload;
      this.write(event, thread.agentId, {
        threadId: thread.threadId,
        status: thread.status,
        closedAt: thread.closedAt,
        closeReason: thread.closeReason,
      });
    }
  }

  private write(
    event: ScoutEvent,
    agentId: string,
    data: object,
  ): void {
    this.loggerFor(agentId).info({
      module: "agent.thread",
      event: event.key.routeKey,
      agentId,
      data,
    });
  }

  private loggerFor(agentId: string): Logger {
    const existing = this.threadLoggers.get(agentId);
    if (existing) return existing;
    const scope = currentRunScope();
    const agent = scope.agentRegistry.resolveAgent(agentId);
    const logger = new Logger({
      runId: scope.runId,
      logsRoot: agent.mount.logsRoot,
      fileName: "thread.log",
      summarizer: (event) => event,
    });
    this.threadLoggers.set(agentId, logger);
    return logger;
  }
}

function summarizeThreadStartInput(
  agentId: string,
  role: ScoutAgentRole,
  input: AgentThreadSnapshot["startInput"],
): object {
  const {
    baseInstructions,
    developerInstructions,
    dynamicTools,
    ...metadata
  } = input;
  return {
    ...summarizeThreadRequestMetadata(agentId, metadata),
    ...(baseInstructions === undefined ? {} : { hasBaseInstructions: true }),
    ...summarizeDeveloperInstructions(role, developerInstructions),
    ...(dynamicTools === undefined
      ? {}
      : {
          dynamicTools: dynamicTools.map((tool) => ({
            namespace: tool.namespace ?? null,
            name: tool.name,
          })),
        }),
  };
}

function summarizeThreadResumeInput(
  agentId: string,
  role: ScoutAgentRole,
  input: AgentThreadResumeRecord["resumeInput"],
): object {
  const {
    baseInstructions,
    developerInstructions,
    ...metadata
  } = input;
  return {
    ...summarizeThreadRequestMetadata(agentId, metadata),
    ...(baseInstructions === undefined ? {} : { hasBaseInstructions: true }),
    ...summarizeDeveloperInstructions(role, developerInstructions),
  };
}

function summarizeThreadResponse(agentId: string, value: unknown): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { received: value !== undefined };
  }
  const response = value as Record<string, unknown>;
  const thread = typeof response.thread === "object"
      && response.thread !== null
      && !Array.isArray(response.thread)
    ? response.thread as Record<string, unknown>
    : undefined;
  const sandbox = typeof response.sandbox === "object"
      && response.sandbox !== null
      && !Array.isArray(response.sandbox)
    ? response.sandbox as Record<string, unknown>
    : undefined;
  const stringValue = (record: Record<string, unknown> | undefined, key: string) =>
    typeof record?.[key] === "string" ? record[key] : undefined;
  const stringArray = (record: Record<string, unknown>, key: string) =>
    Array.isArray(record[key])
      ? record[key].filter((item): item is string => typeof item === "string")
      : undefined;
  const pathValue = (
    record: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined => {
    const value = stringValue(record, key);
    return value === undefined ? undefined : summarizePortablePath(agentId, value);
  };
  const pathArray = (record: Record<string, unknown>, key: string) => {
    const values = stringArray(record, key);
    return values?.map((value) => summarizePortablePath(agentId, value));
  };
  return {
    ...(thread
      ? {
          thread: {
            id: stringValue(thread, "id"),
            path: pathValue(thread, "path"),
            cwd: pathValue(thread, "cwd"),
            cliVersion: stringValue(thread, "cliVersion"),
          },
        }
      : {}),
    model: stringValue(response, "model"),
    modelProvider: stringValue(response, "modelProvider"),
    cwd: pathValue(response, "cwd"),
    runtimeWorkspaceRoots: pathArray(response, "runtimeWorkspaceRoots"),
    instructionSources: pathArray(response, "instructionSources"),
    approvalPolicy: stringValue(response, "approvalPolicy"),
    ...(sandbox
      ? {
          sandbox: {
            type: stringValue(sandbox, "type"),
          },
        }
      : {}),
  };
}

function summarizeThreadRequestMetadata(
  agentId: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...metadata };
  for (const key of ["cwd", "path"] as const) {
    if (typeof result[key] === "string") {
      result[key] = summarizePortablePath(agentId, result[key]);
    }
  }
  if (Array.isArray(result.runtimeWorkspaceRoots)) {
    result.runtimeWorkspaceRoots = result.runtimeWorkspaceRoots
      .filter((value): value is string => typeof value === "string")
      .map((value) => summarizePortablePath(agentId, value));
  }
  return result;
}

function summarizePortablePath(agentId: string, value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.length === 0) return normalized;

  const scope = currentRunScope();
  const agent = scope.agentRegistry.findAgent(agentId);
  const mount = agent?.mount;
  const runRoot = join(scope.repoRoot, "run", scope.runId);
  const roots = [
    [mount?.mountRoot, "${SCOUT_MOUNT_ROOT}"],
    [mount?.artifactRoot, "${SCOUT_ARTIFACT_ROOT}"],
    [mount?.runRoot, "${SCOUT_RUN_ROOT}"],
    [runRoot, "${SCOUT_RUN_ROOT}"],
    [scope.repoRoot, "${SCOUT_REPO_ROOT}"],
  ] as const;
  for (const [root, label] of roots) {
    if (!root || !isPathWithin(root, value)) continue;
    const suffix = relative(resolve(root), resolve(value))
      .split(sep)
      .filter(Boolean)
      .join("/");
    return suffix ? `${label}/${suffix}` : label;
  }

  const sessionsMarker = "/.codex/sessions/";
  const sessionsIndex = normalized.indexOf(sessionsMarker);
  if (sessionsIndex >= 0) {
    return `sessions/${normalized.slice(sessionsIndex + sessionsMarker.length)}`;
  }
  if (normalized.endsWith("/.codex/sessions")) return "sessions";

  // A response can contain paths from the source device. Recognize the stable
  // run layout by run id and agent role before falling back to a filename.
  const runMarker = `/run/${scope.runId}/`;
  const runIndex = normalized.indexOf(runMarker);
  if (runIndex >= 0) {
    const suffix = normalized.slice(runIndex + runMarker.length);
    const mountMarker = `agents/${agentId}/mount`;
    const artifactMarker = `agents/${agentId}/artifacts`;
    if (suffix === mountMarker || suffix.startsWith(`${mountMarker}/`)) {
      return suffix === mountMarker
        ? "${SCOUT_MOUNT_ROOT}"
        : `\${SCOUT_MOUNT_ROOT}/${suffix.slice(mountMarker.length + 1)}`;
    }
    if (suffix === artifactMarker || suffix.startsWith(`${artifactMarker}/`)) {
      return suffix === artifactMarker
        ? "${SCOUT_ARTIFACT_ROOT}"
        : `\${SCOUT_ARTIFACT_ROOT}/${suffix.slice(artifactMarker.length + 1)}`;
    }
    return suffix ? `\${SCOUT_RUN_ROOT}/${suffix}` : "\${SCOUT_RUN_ROOT}";
  }

  if (!isAbsolute(value) && !/^[A-Za-z]:\//.test(normalized)) {
    return normalized.replace(/^\.\//, "");
  }
  return basename(normalized);
}

function summarizeDeveloperInstructions(
  role: ScoutAgentRole,
  developerInstructions: string | undefined,
): object {
  if (developerInstructions === undefined) return {};
  return {
    developerInstructions: role === ScoutAgentRoles.Coordinator
      ? roleAgentInstructionAssetPaths(role)
      : workerRoleInstructionAssetPaths(role),
    ...(role === ScoutAgentRoles.Coordinator
      ? { hasInlineDeveloperInstructions: true }
      : {}),
  };
}

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../../agent/tools/types.js";
import type {
  ScoutDomain,
  ScoutDomainDynamicToolCall,
} from "../types.js";
import { ValidationDomainAgentBackend } from "./agent/backend/validation-domain-agent-backend.js";
import type { DynamicToolCallResponse } from "../../agent-server/types.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../../agent/events/index.js";
import { ValidationEvents } from "./validation-events.js";
import {
  EventSubscriptionPriorities,
  type UnsubscribeEventHandler,
} from "../../core/events/index.js";

/**
 * Owns validation artifact/gate facts, rebuilding its in-memory indexes from the run journal
 * and publishing newly discovered immutable artifacts through the current run event bus.
 * It does not decide task scheduling or render interaction state; those responsibilities stay
 * with the run orchestrator and interaction port.
 */
export class ValidationDomain implements ScoutDomain {
  readonly domainId = "validation";
  readonly name = "Scout Validation Domain";
  readonly backend = new ValidationDomainAgentBackend();
  private readonly recordedArtifacts = new Set<string>();
  private readonly recordedGates = new Map<string, string>();
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];

  /** Installs idempotent subscriptions that update validation indexes as runtime facts arrive. */
  async start(): Promise<void> {
    if (this.unsubscribers.length > 0) return;
    const eventBus = currentRunScope().eventBus;
    this.unsubscribers.push(
      eventBus.subscribe(AgentEvents.task.outcomeSubmitted, (event) => {
        if (AgentEvents.task.outcomeSubmitted.is(event)) {
          this.recordArtifacts(event.payload.task.role, event.payload.task.taskId);
        }
      }, {
        priority: EventSubscriptionPriorities.Normal,
      }),
      eventBus.subscribe(ValidationEvents.artifact.published, (event) => {
        if (ValidationEvents.artifact.published.is(event)) {
          this.recordedArtifacts.add(`${event.payload.ref}\0${event.payload.digest}`);
        }
      }, {
        priority: EventSubscriptionPriorities.Normal,
      }),
      eventBus.subscribe(ValidationEvents.gate.recorded, (event) => {
        if (ValidationEvents.gate.recorded.is(event)) {
          this.recordedGates.set(event.payload.gateRef, event.payload.gateDigest);
        }
      }, {
        priority: EventSubscriptionPriorities.Normal,
      }),
    );
  }

  /** Removes the subscriptions owned by this domain instance. */
  async stop(): Promise<void> {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
  }

  /** Returns no role-specific tools because validation has no dynamic tool surface yet. */
  dynamicToolsForRole(_role: ScoutAgentRole): AgentDynamicToolSpec[] {
    return [];
  }

  /** Delegates a dynamic-tool call to the validation backend without changing its response shape. */
  handleDynamicToolCall(call: ScoutDomainDynamicToolCall): DynamicToolCallResponse | undefined {
    return this.backend.handleDynamicToolCall(call);
  }

  /** Reconstructs recorded artifact/gate indexes from journal facts and current artifact mounts. */
  restore(): void {
    const scope = currentRunScope();
    const events = scope.journal.readAll();
    this.recordedArtifacts.clear();
    this.recordedGates.clear();
    for (const event of events) {
      if (ValidationEvents.artifact.published.is(event)) {
        this.recordedArtifacts.add(`${event.payload.ref}\0${event.payload.digest}`);
      } else if (ValidationEvents.gate.recorded.is(event)) {
        this.recordedGates.set(event.payload.gateRef, event.payload.gateDigest);
      }
    }
    for (const role of Object.keys(scope.environment.agents) as ScoutAgentRole[]) {
      let latestTaskId: string | undefined;
      for (const event of [...events].reverse()) {
        if (AgentEvents.task.outcomeSubmitted.is(event)) {
          if (event.payload.task.role === role) {
            latestTaskId = event.payload.task.taskId;
            break;
          }
          continue;
        }
        if (
          AgentEvents.task.assigned.is(event)
          || AgentEvents.task.stepStarted.is(event)
          || AgentEvents.task.stepCompleted.is(event)
          || AgentEvents.task.stepInterrupted.is(event)
          || AgentEvents.task.done.is(event)
          || AgentEvents.task.archived.is(event)
          || AgentEvents.task.failed.is(event)
          || AgentEvents.task.stopped.is(event)
        ) {
          if (event.payload.role === role) {
            latestTaskId = event.payload.taskId;
            break;
          }
        }
      }
      this.recordArtifacts(role, latestTaskId);
    }
  }

  private recordArtifacts(role: ScoutAgentRole, submittedTaskId?: string): void {
    const scope = currentRunScope();
    const agent = scope.environment.agents[role];
    const artifactRoot = resolve(agent.mount.artifactRoot);
    if (!existsSync(artifactRoot)) return;
    const runRoot = resolve(scope.runRoot);
    const entries = readdirSync(artifactRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .filter((entry) => {
        if (entry.name.startsWith(".")) return false;
        const isResearchPackName = role === ScoutAgentRoles.Researcher
          && entry.name.endsWith("-research-pack");
        const isResearchGateName = role === ScoutAgentRoles.Validator
          && /^research-pack-gate-[0-9]{4}\.md$/.test(entry.name);
        if (!isResearchPackName && !isResearchGateName) return false;
        if (
          entry.isSymbolicLink()
          || (isResearchPackName && !entry.isDirectory())
          || (isResearchGateName && !entry.isFile())
        ) {
          throw new Error(`Unsupported Validation artifact entry for ${role}: ${entry.name}`);
        }
        return true;
      });
    if (entries.length === 0) return;
    const digestTool = join(agent.mount.mountRoot, "bin", "scout-artifact-digest");
    if (!existsSync(digestTool)) {
      throw new Error(`Validation artifact digest tool is unavailable for ${role}: ${digestTool}`);
    }
    for (const entry of entries) {
      const isResearchPack = role === ScoutAgentRoles.Researcher
        && entry.isDirectory()
        && entry.name.endsWith("-research-pack");
      const isResearchGate = role === ScoutAgentRoles.Validator
        && entry.isFile()
        && /^research-pack-gate-[0-9]{4}\.md$/.test(entry.name);
      const path = join(artifactRoot, entry.name);
      const ref = relative(runRoot, path).split(sep).join("/");
      const digest = readArtifactDigest(digestTool, path);
      const artifactKey = `${ref}\0${digest}`;
      if (!this.recordedArtifacts.has(artifactKey)) {
        const publishedAt = statSync(path).mtime.toISOString();
        scope.eventBus.publish(ValidationEvents.artifact.published, {
          artifactId: `${role}:${ref}`,
          taskId: submittedTaskId,
          agentId: role,
          role,
          ref,
          digest,
          status: "published",
          publishedAt,
        }, {
          occurredAt: publishedAt,
        });
      }

      if (!isResearchGate) continue;
      const fields = readFrontmatter(path);
      const gateId = requiredFrontmatter(fields, "gate_id", path);
      const checkedRef = requiredFrontmatter(fields, "checked_pack_ref", path);
      const checkedDigest = requiredFrontmatter(fields, "checked_pack_digest", path);
      const status = requiredFrontmatter(fields, "gate", path);
      const recordedGateDigest = this.recordedGates.get(ref);
      if (recordedGateDigest && recordedGateDigest !== digest) {
        throw new Error(`Immutable Validation Gate artifact changed after recording: ${ref}`);
      }
      if (recordedGateDigest) continue;
      const recordedAt = validTimestamp(fields.get("created_at"))
        ?? statSync(path).mtime.toISOString();
      scope.eventBus.publish(ValidationEvents.gate.recorded, {
        gateId,
        taskId: fields.get("validator_task_id") || submittedTaskId,
        agentId: role,
        checkedRef,
        checkedDigest,
        gateRef: ref,
        gateDigest: digest,
        status,
        recordedAt,
      }, {
        occurredAt: recordedAt,
      });
    }
  }
}

function readArtifactDigest(tool: string, path: string): string {
  const output = execFileSync(tool, [path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (fields.get("artifact_digest_valid") !== "true" || !fields.get("digest")) {
    throw new Error(`Validation artifact digest failed for ${path}.`);
  }
  return fields.get("digest") as string;
}

function readFrontmatter(path: string): Map<string, string> {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error(`Validation Gate has no frontmatter: ${path}`);
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return fields;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");
    fields.set(key, value);
  }
  throw new Error(`Validation Gate frontmatter is not closed: ${path}`);
}

function requiredFrontmatter(
  fields: Map<string, string>,
  key: string,
  path: string,
): string {
  const value = fields.get(key);
  if (!value || value.includes("<填写")) {
    throw new Error(`Validation Gate ${path} has no usable ${key}.`);
  }
  return value;
}

function validTimestamp(value: string | undefined): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

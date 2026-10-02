import type {
  ScoutAgentPhase,
  ScoutAgentRole,
} from "../agent/thread/types.js";
import type { ScoutEvent } from "../core/events/index.js";
import type { DynamicToolCallInput } from "../agent-server/types.js";
import type { ScoutWorkflowParticipant } from "../core/workflow/workflow-participant.js";
import type { DomainAgentBackend } from "./agent/domain-agent-backend.js";

/** Stable identities of Scout Domain runtimes available to a Workflow. */
export enum ScoutDomainId {
  Base = "base",
  Rbt = "rbt",
}

/** Immutable identity and display metadata owned by one Scout Domain. */
export interface ScoutDomainDescription {
  readonly id: ScoutDomainId;
  readonly name: string;
}

export function isScoutDomainId(value: unknown): value is ScoutDomainId {
  return typeof value === "string"
    && Object.values(ScoutDomainId).some((domainId) => domainId === value);
}

/** Dynamic-tool invocation forwarded from an agent server into a domain backend. */
export interface ScoutDomainDynamicToolCall {
  input: DynamicToolCallInput;
  caller: {
    agentId: string;
    role: ScoutAgentRole;
    phase: ScoutAgentPhase;
    threadId?: string;
  };
}

/** Artifact fact shape that a Domain may expose to the shared resume projection. */
export interface ScoutDomainArtifactFact {
  artifactId: string;
  taskId?: string;
  agentId: string;
  role: string;
  ref: string;
  digest: string;
  status: string;
  publishedAt: string;
}

/** Gate fact shape that a Domain may expose to the shared resume projection. */
export interface ScoutDomainGateFact {
  gateId: string;
  taskId?: string;
  agentId: string;
  checkedRef: string;
  checkedDigest: string;
  gateRef: string;
  gateDigest: string;
  status: string;
  recordedAt: string;
}

/** One Domain-owned fact projected from a persisted Domain event. */
export type ScoutDomainRecordFact =
  | { kind: "artifact"; payload: ScoutDomainArtifactFact }
  | { kind: "gate"; payload: ScoutDomainGateFact };

/** Stable fields shared by Domain runtime facts rebuilt from a Domain journal. */
export interface ScoutDomainRuntimeFact {
  domainId: string;
  journalSeq: number;
  updatedAt?: string;
}

/** Persisted Domain event shape accepted by a Domain-owned runtime projection. */
export interface ScoutDomainRecordEvent extends ScoutEvent {
  version: 1;
  seq: number;
  recordedAt: string;
}

/** Lifecycle and tool surface owned by a Scout domain implementation. */
export interface ScoutDomain extends ScoutWorkflowParticipant {
  readonly description: ScoutDomainDescription;
  readonly backend: DomainAgentBackend;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

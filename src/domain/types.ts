import type { ScoutAgentRole } from "../agent/thread/types.js";
import type { AgentDynamicToolSpec } from "../agent/tools/types.js";
import type {
  EventType,
  ScoutEvent,
} from "../core/events/index.js";
import type {
  DynamicToolCallInput,
  DynamicToolCallResponse,
} from "../agent-server/types.js";

/** Dynamic-tool invocation forwarded from an agent server into a domain backend. */
export interface ScoutDomainDynamicToolCall {
  input: DynamicToolCallInput;
  caller: {
    agentId: string;
    role: ScoutAgentRole;
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
export type ScoutDomainJournalFact =
  | { kind: "artifact"; payload: ScoutDomainArtifactFact }
  | { kind: "gate"; payload: ScoutDomainGateFact };

/** Domain-owned event persistence and resume projection boundary. */
export interface ScoutDomainJournalProjection {
  readonly eventTypes: readonly EventType[];
  project(event: ScoutEvent, journalSeq: number): ScoutDomainJournalFact | undefined;
}

/** Lifecycle and tool surface owned by a Scout domain implementation. */
export interface ScoutDomain {
  readonly domainId: string;
  readonly name: string;
  dynamicToolsForRole(role: ScoutAgentRole): AgentDynamicToolSpec[];
  readonly journal?: ScoutDomainJournalProjection;
  handleDynamicToolCall?(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse | undefined> | DynamicToolCallResponse | undefined;
  restore?(): Promise<void> | void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

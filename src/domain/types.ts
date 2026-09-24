import type {
  ScoutAgentPhase,
  ScoutAgentRole,
} from "../agent/thread/types.js";
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
export type ScoutDomainJournalFact =
  | { kind: "artifact"; payload: ScoutDomainArtifactFact }
  | { kind: "gate"; payload: ScoutDomainGateFact };

/** Stable fields shared by Domain runtime facts rebuilt from a Domain journal. */
export interface ScoutDomainRuntimeFact {
  domainId: string;
  journalSeq: number;
  updatedAt?: string;
}

/** Persisted Domain event shape accepted by a Domain-owned runtime projection. */
export interface ScoutDomainJournalEvent extends ScoutEvent {
  seq: number;
  recordedAt: string;
}

/** Domain-owned event contract and read-model projection boundary. */
export interface ScoutDomainJournalProjection<
  TRuntimeFact extends ScoutDomainRuntimeFact = ScoutDomainRuntimeFact,
> {
  /** Event routes written to `<domain>-events.jsonl`, never to the Scout journal. */
  readonly eventTypes: readonly EventType[];
  /** Projects a Domain journal event into shared resume facts when needed. */
  project(event: ScoutEvent, journalSeq: number): ScoutDomainJournalFact | undefined;
  /** Rebuilds the Domain's current runtime facts from its persisted event stream. */
  aggregate?(events: readonly ScoutDomainJournalEvent[]): TRuntimeFact;
}

/** Lifecycle and tool surface owned by a Scout domain implementation. */
export interface ScoutDomain {
  readonly domainId: string;
  readonly name: string;
  dynamicToolsForPhase(phase: ScoutAgentPhase): AgentDynamicToolSpec[];
  readonly journal?: ScoutDomainJournalProjection;
  handleDynamicToolCall?(
    call: ScoutDomainDynamicToolCall,
  ): Promise<DynamicToolCallResponse | undefined> | DynamicToolCallResponse | undefined;
  restore?(): Promise<void> | void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

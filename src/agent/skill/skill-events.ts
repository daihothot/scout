import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { ScoutAgentPhase, ScoutAgentRole } from "../thread/types.js";

/** Identity linking a Skill event to its authorized agent turn. */
export interface AgentSkillEventContext {
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  turnId: string;
  callId: string;
}

/** One direct family choice and the number of matching catalog entries. */
export interface AgentSkillFamilyFacet {
  value: string;
  count: number;
}

/** Successful FindSkills result, including refinement or dependency order. */
export interface AgentSkillFindCompletedEvent extends AgentSkillEventContext {
  phase: ScoutAgentPhase;
  family: string[];
  availableFamilies: AgentSkillFamilyFacet[];
  status: "refine_required" | "selected";
  reason?: string;
  candidateIds: string[];
  loadOrder?: string[];
}

/** Failure fact emitted when FindSkills rejects a request. */
export interface AgentSkillFindFailedEvent extends AgentSkillEventContext {
  phase: ScoutAgentPhase;
  family: string[];
  errorCode: string;
}

/** Successful resource read fact with content identity and size. */
export interface AgentSkillReadCompletedEvent extends AgentSkillEventContext {
  selectionId: string;
  skillId: string;
  resource: string;
  digest: string;
  byteLength: number;
}

/** Failure fact emitted when a selected Skill resource cannot be read safely. */
export interface AgentSkillReadFailedEvent extends AgentSkillEventContext {
  selectionId: string;
  skillId: string;
  errorCode: string;
}

const agentSkillEventCatalog = {
  skill: {
    findCompleted: event<AgentSkillFindCompletedEvent>(),
    findFailed: event<AgentSkillFindFailedEvent>(),
    readCompleted: event<AgentSkillReadCompletedEvent>(),
    readFailed: event<AgentSkillReadFailedEvent>(),
  },
} as const;

AgentEvents.add(agentSkillEventCatalog);

/** Event routes produced by the Skill backend. */
export type AgentSkillEventCatalog = typeof agentSkillEventCatalog;

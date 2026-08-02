import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { ScoutAgentPhase, ScoutAgentRole } from "../thread/types.js";

export interface AgentSkillEventContext {
  agentId: string;
  role: ScoutAgentRole;
  taskId?: string;
  threadId: string;
  turnId: string;
  callId: string;
}

export interface AgentSkillFamilyFacet {
  value: string;
  count: number;
}

export interface AgentSkillFindCompletedEvent extends AgentSkillEventContext {
  phase: ScoutAgentPhase;
  family: string[];
  availableFamilies: AgentSkillFamilyFacet[];
  status: "refine_required" | "selected";
  reason?: string;
  candidateIds: string[];
  loadOrder?: string[];
}

export interface AgentSkillFindFailedEvent extends AgentSkillEventContext {
  phase: ScoutAgentPhase;
  family: string[];
  errorCode: string;
}

export interface AgentSkillReadCompletedEvent extends AgentSkillEventContext {
  selectionId: string;
  skillId: string;
  resource: string;
  digest: string;
  byteLength: number;
}

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

export type AgentSkillEventCatalog = typeof agentSkillEventCatalog;

import type {
  ScoutSkillCatalogEntry,
  ScoutSkillResourceRequirement,
} from "../../asset-store/contracts/skill.js";
import type { ScoutAgentPhase, ScoutAgentRole } from "../thread/types.js";

/** Runtime identity that owns one Skill protocol action. */
export interface AgentSkillRuntimeScope {
  agentId: string;
  taskId: string | undefined;
  threadId: string;
  turnId: string;
  assetCommitId: string;
  phase: ScoutAgentPhase;
}

/** In-progress navigation through the Skill family catalog for one turn. */
export interface AgentSkillDiscovery {
  scope: AgentSkillRuntimeScope;
  familyPrefix: string[];
  availableFamilies: string[];
}

/** One Skill and its direct predecessors in a resolved selection. */
export interface AgentSkillSelectionSkill {
  skillId: string;
  requiredSkillIds: string[];
}

/** One resource authorized by a resolved Skill selection. */
export interface AgentSkillSelectionResource {
  skillId: string;
  resource: string;
  requirement: ScoutSkillResourceRequirement;
  description: string;
}

/** Immutable inputs used to issue one Skill selection. */
export interface AgentSkillSelectionDefinition {
  scope: AgentSkillRuntimeScope;
  selectionId: string;
  family: string[];
  selectedSkillIds: string[];
  loadOrder: AgentSkillSelectionSkill[];
  resources: AgentSkillSelectionResource[];
}

/** Stable identity of a resource within one selection. */
export interface AgentSkillResourceIdentity {
  skillId: string;
  resource: string;
}

/** Detached state snapshot for one issued selection. */
export interface AgentSkillSelectionState extends AgentSkillSelectionDefinition {
  loadedResources: AgentSkillResourceIdentity[];
}

/** Consumer-facing readiness projection for one selection. */
export interface AgentSkillSelectionProjection {
  selectionId: string;
  selectionState: "loading" | "ready";
  loadedRequiredResources: AgentSkillResourceIdentity[];
  missingRequiredResources: AgentSkillResourceIdentity[];
}

/** One direct family choice and the number of matching catalog entries. */
export interface AgentSkillFamilyFacet {
  value: string;
  count: number;
}

/** Public scope projection returned by the Skill discovery tool. */
export interface AgentSkillScopeProjection {
  agentId: string;
  role: ScoutAgentRole;
  phase: ScoutAgentPhase;
  assetCommitId: string;
}

/** Public metadata projection for one declared Skill resource. */
export interface AgentSkillResourceCatalogProjection {
  skillId: string;
  resource: string;
  description?: string;
}

/** Public metadata projection for one Skill candidate. */
export interface AgentSkillCandidateProjection {
  skillId: string;
  description: string;
  summary: string;
  phase: ScoutAgentPhase[];
  family?: string[];
  tags: string[];
  requiredSkills: string[];
  resources: {
    required: Array<{
      resource: string;
      description: string;
    }>;
    optional: Array<{
      resource: string;
      description: string;
    }>;
  };
}

/** Public refinement response produced by the Skill facade. */
export interface AgentSkillFindRefinementResponse {
  status: "refine_required";
  refineRequired: true;
  reason: AgentSkillRefinement["reason"];
  scope: AgentSkillScopeProjection;
  family: string[];
  requestedFamily?: string[];
  navigation?: {
    state: "reset";
    restartFamily: string[];
  };
  total: number;
  facets: {
    families: AgentSkillFamilyFacet[];
  };
  candidates?: AgentSkillCandidateProjection[];
}

/** Public selected response produced by the Skill facade. */
export interface AgentSkillFindSelectedResponse {
  status: "selected";
  refineRequired: false;
  scope: AgentSkillScopeProjection;
  family: string[];
  selectionId: string;
  selectedSkillIds: string[];
  loadOrder: string[];
  resources: {
    required: AgentSkillResourceCatalogProjection[];
    optional: AgentSkillResourceCatalogProjection[];
  };
  selectionState: AgentSkillSelectionProjection["selectionState"];
  loadedRequiredResources: AgentSkillResourceIdentity[];
  missingRequiredResources: AgentSkillResourceIdentity[];
  skills?: Array<AgentSkillCandidateProjection & {
    selectionReason: "family_match" | "required_dependency";
  }>;
}

/** Public Skill discovery response. */
export type AgentSkillFindResponse =
  | AgentSkillFindRefinementResponse
  | AgentSkillFindSelectedResponse;

/** Skill facts needed by ToolBackend to publish a completed discovery event. */
export interface AgentSkillFindTelemetry {
  status: AgentSkillFindCompletedEventStatus;
  reason?: string;
  family: string[];
  availableFamilies: AgentSkillFamilyFacet[];
  candidateIds: string[];
  loadOrder?: string[];
}

/** One completed Skill discovery, separated from Tool transport concerns. */
export interface AgentSkillFindExecution {
  response: AgentSkillFindResponse;
  telemetry: AgentSkillFindTelemetry;
}

type AgentSkillFindCompletedEventStatus = "refine_required" | "selected";

/** Public resource-read response produced by the Skill facade. */
export interface AgentSkillReadResponse {
  status: "loaded";
  skillId: string;
  resource: string;
  digest: string;
  byteLength: number;
  content: string;
  selectionId: string;
  selectionState: AgentSkillSelectionProjection["selectionState"];
  loadedRequiredResources: AgentSkillResourceIdentity[];
  missingRequiredResources: AgentSkillResourceIdentity[];
}

/** One completed Skill resource read, including the event-only requirement. */
export interface AgentSkillReadExecution {
  response: AgentSkillReadResponse;
  requirement: ScoutSkillResourceRequirement;
}

/** Runtime inputs for one complete FindSkills domain transition. */
export interface FindAgentSkillsInput {
  scope: AgentSkillRuntimeScope;
  catalog: ScoutSkillCatalogEntry[];
  family?: string[];
}

/** A non-leaf FindSkills result that keeps discovery active for this turn. */
export interface AgentSkillRefinement {
  status: "refine_required";
  reason:
    | "no_phase_candidates"
    | "family_required"
    | "family_child_required"
    | "family_navigation_reset";
  family: string[];
  requestedFamily?: string[];
  candidates: ScoutSkillCatalogEntry[];
  availableFamilies: AgentSkillFamilyFacet[];
}

/** A leaf FindSkills result with one newly issued selection. */
export interface AgentSkillSelected {
  status: "selected";
  family: string[];
  loadOrderSkills: ScoutSkillCatalogEntry[];
  selection: AgentSkillSelectionDefinition;
  projection: AgentSkillSelectionProjection;
}

/** Closed result vocabulary for the stateful FindSkills operation. */
export type AgentSkillFindResult = AgentSkillRefinement | AgentSkillSelected;

/** Stable protocol error shared by the Skill facade, reader, and store. */
export class AgentSkillError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AgentSkillError";
    this.code = code;
  }
}

/** Projects unknown failures to the public Skill protocol error vocabulary. */
export function agentSkillErrorCode(error: unknown): string {
  return error instanceof AgentSkillError ? error.code : "invalid_request";
}

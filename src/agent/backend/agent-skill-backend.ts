import type { CodexMount } from "../../asset-store/contracts/mount.js";
import {
  ScoutSkillResourceRequirements,
  type ScoutSkillCatalogEntry,
} from "../../asset-store/contracts/skill.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import {
  AgentSkillError,
  normalizeAgentSkillResourcePath,
  readAgentSkillResource,
  type AgentSkillFindResult,
  type AgentSkillFindExecution,
  type AgentSkillCandidateProjection,
  type AgentSkillRuntimeScope,
  type AgentSkillReadExecution,
  type AgentSkillReadResponse,
  type AgentSkillSelectionProjection,
  type AgentSkillSelectionResource,
} from "../skill/index.js";

/**
 * Connects an Agent mount to the run-owned Skill store and resource reader.
 * Tool-call validation, telemetry, and public response projection belong to
 * AgentToolBackend.
 */
export class AgentSkillBackend {
  private readonly scoutRoot: RunScope["scoutRoot"];
  private readonly store: RunScope["skillStore"];

  constructor() {
    const scope = currentRunScope();
    this.scoutRoot = scope.scoutRoot;
    this.store = scope.skillStore;
  }

  findSkills(input: {
    scope: AgentSkillRuntimeScope;
    mount: CodexMount;
    role: import("../thread/types.js").ScoutAgentRole;
    family?: string[];
    detail?: "names" | "metadata";
  }): AgentSkillFindExecution {
    const found: AgentSkillFindResult = this.store.findSkills({
      scope: input.scope,
      catalog: authorizedSkillCatalog(input.mount),
      ...(input.family === undefined ? {} : { family: input.family }),
    });
    if (found.status === "refine_required") {
      const response = {
        status: "refine_required" as const,
        refineRequired: true as const,
        reason: found.reason,
        scope: skillScope(input.mount, input.scope, input.role),
        family: found.family,
        ...(found.requestedFamily === undefined
          ? {}
          : {
              requestedFamily: found.requestedFamily,
              navigation: {
                state: "reset" as const,
                restartFamily: [] as string[],
              },
            }),
        total: found.candidates.length,
        facets: { families: found.availableFamilies },
        ...(input.detail === "metadata"
          ? { candidates: found.candidates.map(skillCandidate) }
          : {}),
      };
      return {
        response,
        telemetry: {
          status: response.status,
          reason: response.reason,
          family: found.family,
          availableFamilies: found.availableFamilies,
          candidateIds: found.candidates.map((skill) => skill.name),
        },
      };
    }

    const directlyMatched = new Set(found.selection.selectedSkillIds);
    const response = {
      status: "selected" as const,
      refineRequired: false as const,
      scope: skillScope(input.mount, found.selection.scope, input.role),
      family: found.family,
      ...selectionCatalogProjection(found.selection.resources, found.projection, input.detail),
      selectionId: found.selection.selectionId,
      selectedSkillIds: [...found.selection.selectedSkillIds],
      loadOrder: found.selection.loadOrder.map((skill) => skill.skillId),
      ...(input.detail === "metadata"
        ? {
            skills: found.loadOrderSkills.map((skill) => ({
              ...skillCandidate(skill),
              selectionReason: directlyMatched.has(skill.name)
                ? "family_match" as const
                : "required_dependency" as const,
            })),
          }
        : {}),
    };
    return {
      response,
      telemetry: {
        status: response.status,
        family: found.family,
        availableFamilies: [],
        candidateIds: found.selection.selectedSkillIds,
        loadOrder: response.loadOrder,
      },
    };
  }

  readSkillResource(input: {
    scope: AgentSkillRuntimeScope;
    mount: CodexMount;
    selectionId: string;
    skillId: string;
    resource: string;
  }): AgentSkillReadExecution {
    const resource = normalizeAgentSkillResourcePath(input.resource);
    const selectedResource = this.store.assertResourceReadable(
      input.scope,
      input.selectionId,
      input.skillId,
      resource,
    );
    const skill = authorizedSkillCatalog(input.mount).find((entry) =>
      entry.name === input.skillId
    );
    if (!skill) {
      throw new AgentSkillError(
        "skill_not_authorized",
        `Skill ${input.skillId} is not authorized by the current profile.`,
      );
    }
    const supplementaryResource = resource === "SKILL.md"
      ? undefined
      : skill.resources.find((entry) => entry.path === resource);
    const loaded = readAgentSkillResource({
      scoutRoot: this.scoutRoot,
      mountRoot: input.mount.mountRoot,
      skill,
      resource,
      supplementaryResource,
    });
    const projection = this.store.recordResourceLoaded(
      input.scope,
      input.selectionId,
      input.skillId,
      resource,
    );
    const response: AgentSkillReadResponse = {
      status: "loaded",
      skillId: input.skillId,
      resource: loaded.resource,
      digest: loaded.digest,
      byteLength: loaded.byteLength,
      content: loaded.content,
      ...projection,
    };
    return {
      response,
      requirement: selectedResource.requirement,
    };
  }

  /** Rejects a formal Worker handoff without complete in-scope selections. */
  assertReadyForTaskSubmission(
    scope: AgentSkillRuntimeScope,
    protocolCorrectionSourceTurnId?: string,
  ): void {
    this.store.assertReadyForTaskSubmission(
      scope,
      protocolCorrectionSourceTurnId,
    );
  }
}

function authorizedSkillCatalog(mount: CodexMount): ScoutSkillCatalogEntry[] {
  const mountedSkills = new Set(mount.skills);
  return mount.skillCatalog.filter((skill) => mountedSkills.has(skill.name));
}

function skillScope(
  mount: CodexMount,
  scope: AgentSkillRuntimeScope,
  role: import("../thread/types.js").ScoutAgentRole,
) {
  return {
    agentId: scope.agentId,
    role,
    phase: scope.phase,
    assetCommitId: scope.assetCommitId,
  };
}

function skillCandidate(skill: ScoutSkillCatalogEntry): AgentSkillCandidateProjection {
  return {
    skillId: skill.name,
    description: skill.description,
    summary: skill.summary,
    phase: [...skill.phase],
    ...(skill.family === undefined ? {} : { family: [...skill.family] }),
    tags: [...skill.tags],
    requiredSkills: [...skill.requiredSkills],
    resources: {
      required: skill.resources
        .filter((resource) => resource.requirement === ScoutSkillResourceRequirements.Required)
        .map((resource) => ({ resource: resource.path, description: resource.description })),
      optional: skill.resources
        .filter((resource) => resource.requirement === ScoutSkillResourceRequirements.Optional)
        .map((resource) => ({ resource: resource.path, description: resource.description })),
    },
  };
}

function selectionCatalogProjection(
  resources: AgentSkillSelectionResource[],
  projection: AgentSkillSelectionProjection,
  detail: "names" | "metadata" | undefined,
) {
  const project = (resource: AgentSkillSelectionResource) => ({
    skillId: resource.skillId,
    resource: resource.resource,
    ...(detail === "metadata" ? { description: resource.description } : {}),
  });
  return {
    resources: {
      required: resources
        .filter((resource) => resource.requirement === ScoutSkillResourceRequirements.Required)
        .map(project),
      optional: resources
        .filter((resource) => resource.requirement === ScoutSkillResourceRequirements.Optional)
        .map(project),
    },
    ...projection,
  };
}

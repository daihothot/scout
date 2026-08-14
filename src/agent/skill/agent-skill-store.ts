import { randomUUID } from "node:crypto";
import { resolveSkillDependencyLoadOrder } from "../../asset-store/assets/skill-catalog.js";
import type { ScoutSkillCatalogEntry } from "../../asset-store/contracts/skill.js";
import { ScoutSkillResourceRequirements } from "../../asset-store/contracts/skill.js";
import {
  AgentSkillError,
  type AgentSkillDiscovery,
  type AgentSkillFamilyFacet,
  type AgentSkillFindResult,
  type AgentSkillResourceIdentity,
  type AgentSkillRuntimeScope,
  type AgentSkillSelectionDefinition,
  type AgentSkillSelectionProjection,
  type AgentSkillSelectionResource,
  type AgentSkillSelectionState,
  type FindAgentSkillsInput,
} from "./types.js";

interface StoredAgentSkillSelection extends AgentSkillSelectionDefinition {
  loadedResourceKeys: Set<string>;
  superseded: boolean;
}

/** In-memory authority for Skill discovery and selection protocol state. */
export class AgentSkillStore {
  private readonly discoveries = new Map<string, AgentSkillDiscovery>();
  private readonly selections = new Map<string, StoredAgentSkillSelection>();

  /** Resolves one family navigation step and owns every resulting state transition. */
  findSkills(input: FindAgentSkillsInput): AgentSkillFindResult {
    this.assertCanStartDiscovery(input.scope);
    const candidates = input.catalog.filter((skill) => skill.family !== undefined);
    const rootFacets = buildImmediateFamilyFacets(candidates, []);

    if (input.family === undefined) {
      this.startDiscovery({
        scope: input.scope,
        familyPrefix: [],
        availableFamilies: rootFacets.map((facet) => facet.value),
      });
      return {
        status: "refine_required",
        reason: candidates.length === 0 ? "no_phase_candidates" : "family_required",
        family: [],
        candidates,
        availableFamilies: rootFacets,
      };
    }

    const family = [...input.family];
    const discovery = this.getDiscovery(input.scope);
    let selectedSkills: ScoutSkillCatalogEntry[];
    if (discovery) {
      const branchCandidates = candidates.filter((skill) =>
        skill.family !== undefined && familyPrefixMatches(skill.family, family)
      );
      const childFacets = buildImmediateFamilyFacets(branchCandidates, family);
      this.updateDiscovery(input.scope, {
        familyPrefix: family,
        availableFamilies: childFacets.map((facet) => facet.value),
      });
      if (childFacets.length > 0) {
        return {
          status: "refine_required",
          reason: "family_child_required",
          family,
          candidates: branchCandidates,
          availableFamilies: childFacets,
        };
      }
      selectedSkills = exactFamilyMatches(branchCandidates, family);
      if (selectedSkills.length === 0) {
        throw new AgentSkillError(
          "family_leaf_not_found",
          `FindSkills family [${family.join(", ")}] does not resolve to a routable leaf.`,
        );
      }
    } else {
      selectedSkills = exactFamilyMatches(candidates, family);
      if (selectedSkills.length === 0) {
        // Reset is itself a discovery action and must remain visible to submission gates.
        this.startDiscovery({
          scope: input.scope,
          familyPrefix: [],
          availableFamilies: rootFacets.map((facet) => facet.value),
        });
        return {
          status: "refine_required",
          reason: "family_navigation_reset",
          family: [],
          requestedFamily: family,
          candidates,
          availableFamilies: rootFacets,
        };
      }
    }

    const loadOrderSkills = resolveSkillDependencyLoadOrder(
      input.catalog,
      selectedSkills.map((skill) => skill.name),
    );
    const selection: AgentSkillSelectionDefinition = {
      scope: input.scope,
      selectionId: `skill-selection-${randomUUID()}`,
      family,
      selectedSkillIds: selectedSkills.map((skill) => skill.name),
      loadOrder: loadOrderSkills.map((skill) => ({
        skillId: skill.name,
        requiredSkillIds: [...skill.requiredSkills],
      })),
      resources: loadOrderSkills.flatMap(selectionResourcesForSkill),
    };
    return {
      status: "selected",
      family,
      loadOrderSkills,
      selection,
      projection: this.issueSelection(selection),
    };
  }

  startDiscovery(discovery: AgentSkillDiscovery): AgentSkillDiscovery {
    this.assertCanStartDiscovery(discovery.scope);
    this.supersedeAllStaleSelections(discovery.scope);
    const stored = cloneDiscovery(discovery);
    this.discoveries.set(skillTurnKey(stored.scope), stored);
    return cloneDiscovery(stored);
  }

  getDiscovery(scope: AgentSkillRuntimeScope): AgentSkillDiscovery | undefined {
    const discovery = this.discoveries.get(skillTurnKey(scope));
    return discovery && sameRuntimeScope(discovery.scope, scope)
      ? cloneDiscovery(discovery)
      : undefined;
  }

  updateDiscovery(
    scope: AgentSkillRuntimeScope,
    update: Pick<AgentSkillDiscovery, "familyPrefix" | "availableFamilies">,
  ): AgentSkillDiscovery {
    const key = skillTurnKey(scope);
    const discovery = this.discoveries.get(key);
    if (!discovery || !sameRuntimeScope(discovery.scope, scope)) {
      throw new AgentSkillError(
        "unknown_discovery",
        "The Skill family discovery is unknown or does not belong to the current runtime scope.",
      );
    }
    const expectedLength = discovery.familyPrefix.length + 1;
    const prefixMatches = discovery.familyPrefix.every((token, index) =>
      update.familyPrefix[index] === token
    );
    const child = update.familyPrefix.at(-1);
    if (
      update.familyPrefix.length !== expectedLength
      || !prefixMatches
      || child === undefined
      || !discovery.availableFamilies.includes(child)
    ) {
      throw new AgentSkillError(
        "family_navigation_mismatch",
        "FindSkills must append exactly one direct family child returned by the preceding call in this turn.",
      );
    }
    const stored: AgentSkillDiscovery = {
      scope: cloneRuntimeScope(scope),
      familyPrefix: [...update.familyPrefix],
      availableFamilies: [...update.availableFamilies],
    };
    this.discoveries.set(key, stored);
    return cloneDiscovery(stored);
  }

  completeDiscovery(scope: AgentSkillRuntimeScope): void {
    const key = skillTurnKey(scope);
    const discovery = this.discoveries.get(key);
    if (discovery && sameRuntimeScope(discovery.scope, scope)) {
      this.discoveries.delete(key);
    }
  }

  issueSelection(definition: AgentSkillSelectionDefinition): AgentSkillSelectionProjection {
    if (this.selections.has(definition.selectionId)) {
      throw new AgentSkillError(
        "duplicate_selection",
        `Skill selection ${definition.selectionId} already exists.`,
      );
    }
    this.assertCanStartDiscovery(definition.scope, "select another Skill");
    this.supersedeAllStaleSelections(definition.scope);
    const stored: StoredAgentSkillSelection = {
      ...cloneSelectionDefinition(definition),
      loadedResourceKeys: new Set<string>(),
      superseded: false,
    };
    this.selections.set(stored.selectionId, stored);
    this.completeDiscovery(stored.scope);
    return selectionProjection(stored);
  }

  getSelection(selectionId: string): AgentSkillSelectionState | undefined {
    const selection = this.selections.get(selectionId);
    return selection ? selectionStateSnapshot(selection) : undefined;
  }

  assertCanStartDiscovery(
    scope: AgentSkillRuntimeScope,
    action = "start another Skill discovery",
  ): void {
    const turnSelections = this.selectionsForTurn(scope);
    const currentSelections = turnSelections.filter((selection) =>
      sameRuntimeScope(selection.scope, scope)
    );
    if (currentSelections.length > 0 && currentSelections.length !== turnSelections.length) {
      throw new AgentSkillError(
        "selection_scope_mismatch",
        `The current turn mixes current and stale Skill selections; run FindSkills again before attempting to ${action}.`,
      );
    }
    this.assertSelectionsReady(currentSelections, action);
  }

  assertResourceReadable(
    scope: AgentSkillRuntimeScope,
    selectionId: string,
    skillId: string,
    resource: string,
  ): AgentSkillSelectionResource {
    const selection = this.selections.get(selectionId);
    if (!selection) {
      throw new AgentSkillError(
        "unknown_selection",
        "ReadSkillResource selection is unknown.",
      );
    }
    if (selection.superseded) {
      throw new AgentSkillError(
        "selection_scope_mismatch",
        "ReadSkillResource selection was superseded when the current runtime scope was reauthorized.",
      );
    }
    if (!sameRuntimeScope(selection.scope, scope)) {
      throw new AgentSkillError(
        "selection_scope_mismatch",
        "ReadSkillResource selection does not belong to the current agent, task, thread, turn, phase, and asset commit.",
      );
    }
    const skill = selection.loadOrder.find((candidate) => candidate.skillId === skillId);
    if (!skill) {
      throw new AgentSkillError(
        "skill_not_selected",
        `Skill ${skillId} is not in the current selection loadOrder.`,
      );
    }
    const selectedResource = selection.resources.find((candidate) =>
      candidate.skillId === skillId && candidate.resource === resource
    );
    if (!selectedResource) {
      throw new AgentSkillError(
        "resource_not_declared",
        `Skill ${skillId} resource ${resource} is not declared by the current selection.`,
      );
    }

    if (resource === "SKILL.md") {
      const missingPredecessors = skill.requiredSkillIds.filter((requiredSkillId) =>
        !selection.loadedResourceKeys.has(selectionResourceKey(requiredSkillId, "SKILL.md"))
      );
      if (missingPredecessors.length > 0) {
        throw new AgentSkillError(
          "load_order_violation",
          `Read direct predecessor SKILL.md resources before Skill ${skillId}: ${missingPredecessors.join(", ")}.`,
        );
      }
    } else if (!selection.loadedResourceKeys.has(selectionResourceKey(skillId, "SKILL.md"))) {
      throw new AgentSkillError(
        "skill_instructions_not_loaded",
        `Read Skill ${skillId} SKILL.md before reading its supplementary resources.`,
      );
    }

    return cloneSelectionResource(selectedResource);
  }

  recordResourceLoaded(
    scope: AgentSkillRuntimeScope,
    selectionId: string,
    skillId: string,
    resource: string,
  ): AgentSkillSelectionProjection {
    this.assertResourceReadable(scope, selectionId, skillId, resource);
    const selection = this.selections.get(selectionId);
    if (!selection) {
      throw new AgentSkillError("unknown_selection", "ReadSkillResource selection is unknown.");
    }
    selection.loadedResourceKeys.add(selectionResourceKey(skillId, resource));
    return selectionProjection(selection);
  }

  selectionProjection(selectionId: string): AgentSkillSelectionProjection | undefined {
    const selection = this.selections.get(selectionId);
    return selection ? selectionProjection(selection) : undefined;
  }

  assertReadyForTaskSubmission(
    scope: AgentSkillRuntimeScope,
    protocolCorrectionSourceTurnId?: string,
  ): void {
    if (protocolCorrectionSourceTurnId !== undefined) {
      this.assertCorrectionReadyForTaskSubmission(scope, protocolCorrectionSourceTurnId);
      return;
    }

    const turnSelections = this.selectionsForTurn(scope);
    this.assertNoStaleSelections(
      turnSelections,
      scope,
      "The current turn's Skill selections are stale; run FindSkills again before submitting the task.",
    );
    this.assertSelectionsReady(turnSelections, "submit the current task");
    if (this.getDiscovery(scope)) {
      throw new AgentSkillError(
        "discovery_incomplete",
        "Complete the current Skill family discovery before submitting the task.",
      );
    }
    if (turnSelections.length === 0) {
      throw new AgentSkillError(
        "selection_required",
        "Select the applicable Skill and read every required resource before submitting the current task.",
      );
    }
  }

  private assertCorrectionReadyForTaskSubmission(
    scope: AgentSkillRuntimeScope,
    sourceTurnId: string,
  ): void {
    if (this.getDiscovery(scope)) {
      throw new AgentSkillError(
        "discovery_incomplete",
        "The protocol-correction turn cannot submit after starting a new Skill family discovery.",
      );
    }

    const currentTurnSelections = this.selectionsForTurn(scope);
    this.assertNoStaleSelections(
      currentTurnSelections,
      scope,
      "The protocol-correction turn contains stale Skill selections.",
    );
    if (currentTurnSelections.length > 0) {
      this.assertSelectionsReady(currentTurnSelections, "submit the current task");
      throw new AgentSkillError(
        "correction_selection_not_allowed",
        "The protocol-correction turn must reuse its source turn Skill selections instead of selecting Skills again.",
      );
    }

    const sourceScope: AgentSkillRuntimeScope = { ...scope, turnId: sourceTurnId };
    const sourceTurnSelections = this.selectionsForTurn(sourceScope);
    this.assertNoStaleSelections(
      sourceTurnSelections,
      sourceScope,
      "The protocol-correction source turn's Skill selections are stale.",
    );
    if (this.getDiscovery(sourceScope)) {
      throw new AgentSkillError(
        "discovery_incomplete",
        "The protocol-correction source turn has an unfinished Skill family discovery.",
      );
    }
    if (sourceTurnSelections.length === 0) {
      throw new AgentSkillError(
        "selection_required",
        "The protocol-correction source turn has no Skill selection to reuse.",
      );
    }
    this.assertSelectionsReady(sourceTurnSelections, "submit the current task");
  }

  private selectionsForTurn(scope: AgentSkillRuntimeScope): StoredAgentSkillSelection[] {
    return [...this.selections.values()].filter((selection) =>
      !selection.superseded && sameTurnIdentity(selection.scope, scope)
    );
  }

  private supersedeAllStaleSelections(scope: AgentSkillRuntimeScope): void {
    const turnSelections = this.selectionsForTurn(scope);
    if (
      turnSelections.length === 0
      || turnSelections.some((selection) => sameRuntimeScope(selection.scope, scope))
    ) {
      return;
    }
    for (const selection of turnSelections) selection.superseded = true;
  }

  private assertNoStaleSelections(
    selections: StoredAgentSkillSelection[],
    scope: AgentSkillRuntimeScope,
    message: string,
  ): void {
    if (selections.some((selection) => !sameRuntimeScope(selection.scope, scope))) {
      throw new AgentSkillError("selection_scope_mismatch", message);
    }
  }

  private assertSelectionsReady(
    selections: StoredAgentSkillSelection[],
    action: string,
  ): void {
    const missing = selections.flatMap((selection) =>
      missingRequiredResources(selection).map((resource) =>
        `${selection.selectionId}:${resource.skillId}/${resource.resource}`
      )
    );
    if (missing.length > 0) {
      throw new AgentSkillError(
        "selection_incomplete",
        `Read every required resource before attempting to ${action}. Missing: ${missing.join(", ")}.`,
      );
    }
  }
}

function sameRuntimeScope(
  left: AgentSkillRuntimeScope,
  right: AgentSkillRuntimeScope,
): boolean {
  return sameTurnIdentity(left, right)
    && left.taskId === right.taskId
    && left.assetCommitId === right.assetCommitId
    && left.phase === right.phase;
}

function sameTurnIdentity(
  left: AgentSkillRuntimeScope,
  right: AgentSkillRuntimeScope,
): boolean {
  return left.agentId === right.agentId
    && left.threadId === right.threadId
    && left.turnId === right.turnId;
}

function skillTurnKey(scope: AgentSkillRuntimeScope): string {
  return `${scope.agentId}\0${scope.threadId}\0${scope.turnId}`;
}

function selectionResourceKey(skillId: string, resource: string): string {
  return `${skillId}\0${resource}`;
}

function selectionStateSnapshot(selection: StoredAgentSkillSelection): AgentSkillSelectionState {
  return {
    ...cloneSelectionDefinition(selection),
    loadedResources: selection.resources
      .filter((resource) =>
        selection.loadedResourceKeys.has(selectionResourceKey(resource.skillId, resource.resource))
      )
      .map(resourceIdentity),
  };
}

function selectionProjection(
  selection: StoredAgentSkillSelection,
): AgentSkillSelectionProjection {
  const requiredResources = selection.resources.filter((resource) =>
    resource.requirement === ScoutSkillResourceRequirements.Required
  );
  const loadedRequiredResources = requiredResources
    .filter((resource) =>
      selection.loadedResourceKeys.has(selectionResourceKey(resource.skillId, resource.resource))
    )
    .map(resourceIdentity);
  const missingRequiredResources = requiredResources
    .filter((resource) =>
      !selection.loadedResourceKeys.has(selectionResourceKey(resource.skillId, resource.resource))
    )
    .map(resourceIdentity);
  return {
    selectionId: selection.selectionId,
    selectionState: missingRequiredResources.length === 0 ? "ready" : "loading",
    loadedRequiredResources,
    missingRequiredResources,
  };
}

function missingRequiredResources(
  selection: StoredAgentSkillSelection,
): AgentSkillSelectionResource[] {
  return selection.resources.filter((resource) =>
    resource.requirement === ScoutSkillResourceRequirements.Required
    && !selection.loadedResourceKeys.has(selectionResourceKey(resource.skillId, resource.resource))
  );
}

function resourceIdentity(resource: AgentSkillSelectionResource): AgentSkillResourceIdentity {
  return { skillId: resource.skillId, resource: resource.resource };
}

function cloneRuntimeScope(scope: AgentSkillRuntimeScope): AgentSkillRuntimeScope {
  return { ...scope };
}

function cloneDiscovery(discovery: AgentSkillDiscovery): AgentSkillDiscovery {
  return {
    scope: cloneRuntimeScope(discovery.scope),
    familyPrefix: [...discovery.familyPrefix],
    availableFamilies: [...discovery.availableFamilies],
  };
}

function cloneSelectionDefinition(
  definition: AgentSkillSelectionDefinition,
): AgentSkillSelectionDefinition {
  return {
    scope: cloneRuntimeScope(definition.scope),
    selectionId: definition.selectionId,
    family: [...definition.family],
    selectedSkillIds: [...definition.selectedSkillIds],
    loadOrder: definition.loadOrder.map((skill) => ({
      skillId: skill.skillId,
      requiredSkillIds: [...skill.requiredSkillIds],
    })),
    resources: definition.resources.map(cloneSelectionResource),
  };
}

function cloneSelectionResource(
  resource: AgentSkillSelectionResource,
): AgentSkillSelectionResource {
  return { ...resource };
}

function exactFamilyMatches(
  skills: ScoutSkillCatalogEntry[],
  family: string[],
): ScoutSkillCatalogEntry[] {
  return skills.filter((skill) =>
    skill.family !== undefined && familyPathsEqual(skill.family, family)
  );
}

function selectionResourcesForSkill(
  skill: ScoutSkillCatalogEntry,
): AgentSkillSelectionResource[] {
  return [{
    skillId: skill.name,
    resource: "SKILL.md",
    requirement: ScoutSkillResourceRequirements.Required,
    description: skill.description,
  }, ...skill.resources.map((resource) => ({
    skillId: skill.name,
    resource: resource.path,
    requirement: resource.requirement,
    description: resource.description,
  }))];
}

function buildImmediateFamilyFacets(
  skills: ScoutSkillCatalogEntry[],
  prefix: string[],
): AgentSkillFamilyFacet[] {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    if (
      skill.family === undefined
      || skill.family.length <= prefix.length
      || !familyPrefixMatches(skill.family, prefix)
    ) {
      continue;
    }
    const child = skill.family[prefix.length];
    if (child !== undefined) counts.set(child, (counts.get(child) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({ value, count }));
}

function familyPrefixMatches(family: string[], prefix: string[]): boolean {
  return prefix.every((token, index) => family[index] === token);
}

function familyPathsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && familyPrefixMatches(left, right);
}

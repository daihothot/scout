import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  resolve,
  win32,
} from "node:path";
import type { DynamicToolCallInput } from "../../agent-server/types.js";
import {
  resolveSkillDependencyLoadOrder,
  type ScoutSkillCatalogEntry,
} from "../../asset-store/assets/skill-catalog.js";
import { currentRunScope, type RunScope } from "../../run/run-scope.js";
import { isPathWithin } from "../../core/path.js";
import type { ScoutAgent } from "../core/scout-agent.js";
import { AgentEvents } from "../events/index.js";
import type {
  AgentSkillEventContext,
  AgentSkillFamilyFacet,
  AgentSkillFindCompletedEvent,
} from "../skill/skill-events.js";
import type {
  FindSkillsToolCall,
  ReadSkillResourceToolCall,
} from "../tools/agent-tools.js";

interface SkillDiscovery {
  agentId: string;
  threadId: string;
  turnId: string;
  assetCommitId: string;
  phase: FindSkillsToolCall["phase"];
  familyPrefix: string[];
  availableFamilies: string[];
}

interface SkillSelection extends SkillDiscovery {
  selectionId: string;
  selectedSkillIds: string[];
  loadOrder: string[];
  loadedSkillIds: Set<string>;
}

const MAX_SKILL_RESOURCE_BYTES = 256 * 1024;
const MAX_SKILL_RESOURCE_PATH_LENGTH = 512;

/**
 * Enforces the two-step Skill protocol for one agent turn. Catalog authority
 * comes from the mounted profile; this backend only reads authorized text and
 * publishes outcomes, never installs or mutates Skills.
 */
export class AgentSkillBackend {
  private readonly eventBus: RunScope["eventBus"];
  private readonly repoRoot: RunScope["repoRoot"];
  private readonly discoveries = new Map<string, SkillDiscovery>();
  private readonly selections = new Map<string, SkillSelection>();

  constructor() {
    const scope = currentRunScope();
    this.eventBus = scope.eventBus;
    this.repoRoot = scope.repoRoot;
  }

  handleFindSkills(
    call: FindSkillsToolCall,
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Record<string, unknown> {
    try {
      return this.findSkills(call, caller, delivery);
    } catch (error) {
      this.eventBus.publish(AgentEvents.skill.findFailed, {
        ...skillEventContext(caller, delivery),
        phase: call.phase,
        family: [...(call.family ?? [])],
        errorCode: skillToolErrorCode(error),
      });
      throw error;
    }
  }

  private findSkills(
    call: FindSkillsToolCall,
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Record<string, unknown> {
    caller.assertOwnsActiveTurn({
      threadId: delivery.threadId,
      turnId: delivery.turnId,
    });
    if (!caller.phases.includes(call.phase)) {
      throw new SkillToolError(
        "phase_mismatch",
        `FindSkills phase ${call.phase} is not assigned to agent ${caller.agentId}.`,
      );
    }

    const discoveryKey = skillTurnKey(caller.agentId, delivery.threadId, delivery.turnId);
    const catalog = authorizedSkillCatalog(caller);
    const candidates = catalog.filter((skill) =>
      skill.family !== undefined && skill.phase.includes(call.phase)
    );
    const rootFacets = buildImmediateFamilyFacets(candidates, []);

    if (!call.family) {
      this.clearStateForAgent(caller.agentId);
      this.discoveries.set(discoveryKey, {
        agentId: caller.agentId,
        threadId: delivery.threadId,
        turnId: delivery.turnId,
        assetCommitId: caller.mount.assetCommitId,
        phase: call.phase,
        familyPrefix: [],
        availableFamilies: rootFacets.map((facet) => facet.value),
      });
      const result = {
        status: "refine_required" as const,
        refineRequired: true,
        reason: candidates.length === 0 ? "no_phase_candidates" : "family_required",
        scope: skillScope(caller, call.phase),
        family: [] as string[],
        total: candidates.length,
        facets: { families: rootFacets },
      };
      this.publishFindCompleted(caller, delivery, {
        status: result.status,
        reason: result.reason,
        phase: call.phase,
        family: [],
        availableFamilies: rootFacets,
        candidateIds: candidates.map((skill) => skill.name),
      });
      return result;
    }

    this.clearSelectionsForAgent(caller.agentId);
    const discovery = this.discoveries.get(discoveryKey);
    if (
      !discovery
      || discovery.assetCommitId !== caller.mount.assetCommitId
      || discovery.phase !== call.phase
    ) {
      const result = {
        status: "refine_required" as const,
        refineRequired: true,
        reason: "family_discovery_required",
        scope: skillScope(caller, call.phase),
        family: [] as string[],
        total: candidates.length,
        facets: { families: rootFacets },
      };
      this.publishFindCompleted(caller, delivery, {
        status: result.status,
        reason: result.reason,
        phase: call.phase,
        family: [...call.family],
        availableFamilies: rootFacets,
        candidateIds: candidates.map((skill) => skill.name),
      });
      return result;
    }

    assertNextFamilyStep(discovery, call.family);
    const family = [...call.family];
    const branchCandidates = candidates.filter((skill) =>
      skill.family !== undefined && familyPrefixMatches(skill.family, family)
    );
    const childFacets = buildImmediateFamilyFacets(branchCandidates, family);
    if (childFacets.length > 0) {
      discovery.familyPrefix = family;
      discovery.availableFamilies = childFacets.map((facet) => facet.value);
      const result = {
        status: "refine_required" as const,
        refineRequired: true,
        reason: "family_child_required",
        scope: skillScope(caller, call.phase),
        family,
        total: branchCandidates.length,
        facets: { families: childFacets },
      };
      this.publishFindCompleted(caller, delivery, {
        status: result.status,
        reason: result.reason,
        phase: call.phase,
        family,
        availableFamilies: childFacets,
        candidateIds: branchCandidates.map((skill) => skill.name),
      });
      return result;
    }

    const matched = branchCandidates.filter((skill) =>
      skill.family !== undefined && familyPathsEqual(skill.family, family)
    );
    if (matched.length === 0) {
      throw new SkillToolError(
        "family_leaf_not_found",
        `FindSkills family [${family.join(", ")}] does not resolve to a routable leaf.`,
      );
    }

    const loadOrder = resolveSkillDependencyLoadOrder(
      catalog,
      matched.map((skill) => skill.name),
    );
    const selectionId = `skill-selection-${randomUUID()}`;
    discovery.familyPrefix = family;
    discovery.availableFamilies = [];
    const selection: SkillSelection = {
      ...discovery,
      selectionId,
      selectedSkillIds: matched.map((skill) => skill.name),
      loadOrder: loadOrder.map((skill) => skill.name),
      loadedSkillIds: new Set<string>(),
    };
    this.selections.set(selectionId, selection);

    const directlyMatched = new Set(selection.selectedSkillIds);
    const result = {
      status: "selected" as const,
      refineRequired: false,
      scope: skillScope(caller, call.phase),
      family,
      selectionId,
      selectedSkillIds: [...selection.selectedSkillIds],
      loadOrder: [...selection.loadOrder],
      skills: loadOrder.map((skill) => ({
        ...skillCandidate(skill),
        selectionReason: directlyMatched.has(skill.name) ? "family_match" : "required_dependency",
      })),
    };
    this.publishFindCompleted(caller, delivery, {
      status: result.status,
      phase: call.phase,
      family,
      availableFamilies: [],
      candidateIds: selection.selectedSkillIds,
      loadOrder: selection.loadOrder,
    });
    return result;
  }

  handleReadSkillResource(
    call: ReadSkillResourceToolCall,
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Record<string, unknown> {
    try {
      return this.readSkillResource(call, caller, delivery);
    } catch (error) {
      this.eventBus.publish(AgentEvents.skill.readFailed, {
        ...skillEventContext(caller, delivery),
        selectionId: call.selection_id,
        skillId: call.skill_id,
        errorCode: skillToolErrorCode(error),
      });
      throw error;
    }
  }

  private readSkillResource(
    call: ReadSkillResourceToolCall,
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
  ): Record<string, unknown> {
    caller.assertOwnsActiveTurn({
      threadId: delivery.threadId,
      turnId: delivery.turnId,
    });
    const selection = this.selections.get(call.selection_id);
    if (!selection) {
      throw new SkillToolError(
        "unknown_selection",
        "ReadSkillResource selection is unknown or no longer current.",
      );
    }
    if (
      selection.agentId !== caller.agentId
      || selection.threadId !== delivery.threadId
      || selection.turnId !== delivery.turnId
      || selection.assetCommitId !== caller.mount.assetCommitId
    ) {
      throw new SkillToolError(
        "selection_scope_mismatch",
        "ReadSkillResource selection does not belong to the current agent, thread, turn, and asset commit.",
      );
    }
    if (!selection.loadOrder.includes(call.skill_id)) {
      throw new SkillToolError(
        "skill_not_selected",
        `Skill ${call.skill_id} is not in the current selection loadOrder.`,
      );
    }

    const skill = authorizedSkillCatalog(caller).find((entry) => entry.name === call.skill_id);
    if (!skill) {
      throw new SkillToolError(
        "skill_not_authorized",
        `Skill ${call.skill_id} is not authorized by the current profile.`,
      );
    }
    const resource = normalizeSkillResourcePath(call.resource);
    this.assertLoadOrder(selection, call.skill_id, resource);
    const loaded = readSkillTextResource(caller, skill, resource, this.repoRoot);

    if (resource === "SKILL.md") selection.loadedSkillIds.add(call.skill_id);
    this.eventBus.publish(AgentEvents.skill.readCompleted, {
      ...skillEventContext(caller, delivery),
      selectionId: selection.selectionId,
      skillId: call.skill_id,
      resource,
      digest: loaded.digest,
      byteLength: loaded.byteLength,
    });
    return {
      status: "loaded",
      selectionId: selection.selectionId,
      skillId: call.skill_id,
      resource,
      digest: loaded.digest,
      byteLength: loaded.byteLength,
      content: loaded.content,
      remainingLoadOrder: selection.loadOrder.filter((skillId) =>
        !selection.loadedSkillIds.has(skillId)
      ),
    };
  }

  private assertLoadOrder(
    selection: SkillSelection,
    skillId: string,
    resource: string,
  ): void {
    if (resource === "SKILL.md") {
      if (selection.loadedSkillIds.has(skillId)) return;
      const expected = selection.loadOrder.find((candidate) =>
        !selection.loadedSkillIds.has(candidate)
      );
      if (expected !== skillId) {
        throw new SkillToolError(
          "load_order_violation",
          `Read Skill ${expected ?? "none"} next according to the selection loadOrder.`,
        );
      }
      return;
    }
    if (selection.loadedSkillIds.size !== selection.loadOrder.length) {
      throw new SkillToolError(
        "skill_instructions_not_loaded",
        "Read every selected SKILL.md in loadOrder before reading templates or references.",
      );
    }
  }

  private clearStateForAgent(agentId: string): void {
    for (const [key, discovery] of this.discoveries) {
      if (discovery.agentId === agentId) this.discoveries.delete(key);
    }
    this.clearSelectionsForAgent(agentId);
  }

  private clearSelectionsForAgent(agentId: string): void {
    for (const [selectionId, selection] of this.selections) {
      if (selection.agentId === agentId) this.selections.delete(selectionId);
    }
  }

  private publishFindCompleted(
    caller: ScoutAgent,
    delivery: DynamicToolCallInput,
    data: Omit<AgentSkillFindCompletedEvent, keyof AgentSkillEventContext>,
  ): void {
    this.eventBus.publish(AgentEvents.skill.findCompleted, {
      ...skillEventContext(caller, delivery),
      ...data,
    });
  }
}

class SkillToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SkillToolError";
    this.code = code;
  }
}

function skillToolErrorCode(error: unknown): string {
  return error instanceof SkillToolError ? error.code : "invalid_request";
}

function skillEventContext(
  caller: ScoutAgent,
  delivery: DynamicToolCallInput,
): AgentSkillEventContext {
  return {
    agentId: caller.agentId,
    role: caller.role,
    taskId: caller.snapshot().activeTask?.taskId,
    threadId: delivery.threadId,
    turnId: delivery.turnId,
    callId: delivery.callId,
  };
}

function skillTurnKey(agentId: string, threadId: string, turnId: string): string {
  return `${agentId}\0${threadId}\0${turnId}`;
}

function authorizedSkillCatalog(caller: ScoutAgent): ScoutSkillCatalogEntry[] {
  const profileSkills = new Set(caller.mount.agentProfile.skills);
  const mountedSkills = new Set(caller.mount.skills);
  return caller.mount.skillCatalog.filter((skill) =>
    profileSkills.has(skill.name) && mountedSkills.has(skill.name)
  );
}

function skillScope(
  caller: ScoutAgent,
  phase: FindSkillsToolCall["phase"],
): Record<string, unknown> {
  return {
    agentId: caller.agentId,
    role: caller.role,
    phase,
    assetCommitId: caller.mount.assetCommitId,
  };
}

function skillCandidate(skill: ScoutSkillCatalogEntry): Record<string, unknown> {
  return {
    skillId: skill.name,
    description: skill.description,
    summary: skill.summary,
    phase: [...skill.phase],
    ...(skill.family === undefined ? {} : { family: [...skill.family] }),
    tags: [...skill.tags],
    requiredSkills: [...skill.requiredSkills],
  };
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

function assertNextFamilyStep(discovery: SkillDiscovery, family: string[]): void {
  const expectedLength = discovery.familyPrefix.length + 1;
  const prefixMatches = familyPathsEqual(
    family.slice(0, discovery.familyPrefix.length),
    discovery.familyPrefix,
  );
  const child = family.at(-1);
  if (
    family.length !== expectedLength
    || !prefixMatches
    || child === undefined
    || !discovery.availableFamilies.includes(child)
  ) {
    throw new SkillToolError(
      "family_navigation_mismatch",
      "FindSkills must append exactly one direct family child returned by the preceding call in this turn.",
    );
  }
}

function familyPrefixMatches(family: string[], prefix: string[]): boolean {
  return prefix.every((token, index) => family[index] === token);
}

function familyPathsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && familyPrefixMatches(left, right);
}

function normalizeSkillResourcePath(resource: string): string {
  if (resource.length > MAX_SKILL_RESOURCE_PATH_LENGTH) {
    throw new SkillToolError(
      "resource_path_too_long",
      `Skill resource path exceeds ${MAX_SKILL_RESOURCE_PATH_LENGTH} characters.`,
    );
  }
  if (
    resource.includes("\0")
    || resource.includes("\\")
    || isAbsolute(resource)
    || win32.isAbsolute(resource)
  ) {
    throw new SkillToolError(
      "invalid_resource_path",
      "Skill resource must be a POSIX relative path without NUL or backslash characters.",
    );
  }
  const segments = resource.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new SkillToolError(
      "invalid_resource_path",
      "Skill resource path cannot contain empty, dot, or parent segments.",
    );
  }
  return segments.join("/");
}

function readSkillTextResource(
  caller: ScoutAgent,
  skill: ScoutSkillCatalogEntry,
  resource: string,
  repoRoot: string,
): { content: string; digest: string; byteLength: number } {
  const mountedSkillsRoot = resolve(caller.mount.mountRoot, ".scout", "skills");
  const declaredSkillFile = resolve(caller.mount.mountRoot, ...skill.path.split("/"));
  const declaredSkillRoot = dirname(declaredSkillFile);
  assertPathInside(mountedSkillsRoot, declaredSkillRoot, "Skill catalog path");

  const expectedSkillRoot = resolve(repoRoot, "assets", "codex", "skills", skill.name);
  let realExpectedSkillRoot: string;
  let realSkillRoot: string;
  let realResourcePath: string;
  try {
    realExpectedSkillRoot = realpathSync(expectedSkillRoot);
    realSkillRoot = realpathSync(declaredSkillRoot);
    realResourcePath = realpathSync(resolve(declaredSkillRoot, ...resource.split("/")));
  } catch {
    throw new SkillToolError(
      "resource_not_found",
      `Skill ${skill.name} resource ${resource} does not exist.`,
    );
  }
  if (realSkillRoot !== realExpectedSkillRoot) {
    throw new SkillToolError(
      "resource_path_escape",
      "Resolved Skill root does not match its authorized source asset.",
    );
  }
  assertPathInside(realSkillRoot, realResourcePath, "Resolved Skill resource");

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(realResourcePath);
  } catch {
    throw new SkillToolError(
      "resource_not_found",
      `Skill ${skill.name} resource ${resource} does not exist.`,
    );
  }
  if (!stat.isFile()) {
    throw new SkillToolError(
      "resource_not_file",
      `Skill ${skill.name} resource ${resource} is not a regular file.`,
    );
  }
  if (stat.size > MAX_SKILL_RESOURCE_BYTES) {
    throw new SkillToolError(
      "resource_too_large",
      `Skill resource exceeds the ${MAX_SKILL_RESOURCE_BYTES} byte limit.`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(realResourcePath);
  } catch {
    throw new SkillToolError(
      "resource_read_failed",
      `Skill ${skill.name} resource ${resource} could not be read.`,
    );
  }
  if (bytes.byteLength > MAX_SKILL_RESOURCE_BYTES) {
    throw new SkillToolError(
      "resource_too_large",
      `Skill resource exceeds the ${MAX_SKILL_RESOURCE_BYTES} byte limit.`,
    );
  }
  if (bytes.includes(0)) {
    throw new SkillToolError("resource_not_text", "Skill resource contains NUL bytes.");
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkillToolError("resource_not_text", "Skill resource is not valid UTF-8 text.");
  }
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    throw new SkillToolError(
      "resource_not_text",
      "Skill resource contains unsupported control characters.",
    );
  }
  return {
    content,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteLength: bytes.byteLength,
  };
}

function assertPathInside(root: string, target: string, label: string): void {
  if (!isPathWithin(root, target)) {
    throw new SkillToolError(
      "resource_path_escape",
      `${label} escapes its authorized Skill root.`,
    );
  }
}

/** Runtime Skill metadata shared by catalog parsing, mount persistence, and routing. */
import type { ScoutAgentPhase } from "../../agent/thread/types.js";

/** Skill responsibility categories understood by the Scout asset catalog. */
export const ScoutSkillTypes = {
  Domain: "domain",
  Internal: "internal",
  Tool: "tool",
  Signal: "signal",
} as const;

export type ScoutSkillType = typeof ScoutSkillTypes[keyof typeof ScoutSkillTypes];

/** Closed requirement vocabulary declared by each supplementary Skill resource. */
export const ScoutSkillResourceRequirements = {
  Required: "required",
  Optional: "optional",
} as const;

export type ScoutSkillResourceRequirement =
  typeof ScoutSkillResourceRequirements[keyof typeof ScoutSkillResourceRequirements];

/** Agent-readable text resource discovered from one Skill's templates or references. */
export interface ScoutSkillResourceCatalogEntry {
  path: string;
  requirement: ScoutSkillResourceRequirement;
  description: string;
}

/** Explicit family range declared by one Skill dependency. */
export interface ScoutSkillFamilyPath {
  family: string[];
  wildcard: "*" | "**";
}

/** Parsed frontmatter projection used for Skill routing and dependency loading. */
export interface ScoutSkillCatalogEntry {
  name: string;
  type: ScoutSkillType;
  description: string;
  summary: string;
  phase?: ScoutAgentPhase[];
  family: string[];
  tags: string[];
  requiredSkills: string[];
  optionalSkills: string[];
  requiredFamilyPaths: ScoutSkillFamilyPath[];
  optionalFamilyPaths: ScoutSkillFamilyPath[];
  path: string;
  resources: ScoutSkillResourceCatalogEntry[];
}

/** Catalog entry whose family paths have been expanded against the current Catalog. */
export interface ResolvedScoutSkillCatalogEntry extends ScoutSkillCatalogEntry {
  resolvedRequiredSkills: string[];
  resolvedOptionalSkills: string[];
}

/** One phase-projected Skill linked into a role mount. */
export interface MaterializedSkill {
  name: string;
  type: ScoutSkillType;
  description: string;
  summary: string;
  phase?: ScoutAgentPhase[];
  family: string[];
  requiredSkills: string[];
  optionalSkills: string[];
  requiredFamilyPaths: ScoutSkillFamilyPath[];
  optionalFamilyPaths: ScoutSkillFamilyPath[];
  path: string;
}

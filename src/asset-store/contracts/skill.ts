/**
 * Validated Skill metadata shared by catalog parsing, mount persistence, and
 * agent routing. Parsing and dependency resolution remain asset capabilities.
 */
import type { ScoutAgentPhase } from "../../agent/thread/types.js";

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

/** Validated frontmatter projection used for Skill routing and dependency loading. */
export interface ScoutSkillCatalogEntry {
  name: string;
  description: string;
  summary: string;
  phase: ScoutAgentPhase[];
  family?: string[];
  tags: string[];
  requiredSkills: string[];
  path: string;
  resources: ScoutSkillResourceCatalogEntry[];
}

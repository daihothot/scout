/**
 * Validated Skill metadata shared by catalog parsing, mount persistence, and
 * agent routing. Parsing and dependency resolution remain asset capabilities.
 */
import type { ScoutAgentPhase } from "../../agent/thread/types.js";

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
}

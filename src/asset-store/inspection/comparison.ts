import { isDeepStrictEqual } from "node:util";
import type {
  AgentProfile,
} from "../contracts/profile.js";
import type { MaterializedMcpServer } from "../contracts/resources.js";
import type { ScoutSkillCatalogEntry } from "../contracts/skill.js";

/** Compares JSON-shaped values without making object property order significant. */
export function sameValue(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(actual, expected);
}

/** Compares string collections as sets because declaration order has no mount meaning. */
export function sameUnorderedStrings(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualCounts = countStrings(actual);
  const expectedCounts = countStrings(expected);
  if (actualCounts.size !== expectedCounts.size) return false;
  for (const [value, count] of actualCounts) {
    if (expectedCounts.get(value) !== count) return false;
  }
  return true;
}

/** Compares profiles while treating only permission roots as unordered sets. */
export function sameAgentProfile(actual: AgentProfile, expected: AgentProfile): boolean {
  return sameValue(normalizeAgentProfile(actual), normalizeAgentProfile(expected));
}

/** Preserves catalog, family, and dependency order while normalizing metadata sets. */
export function sameSkillCatalog(
  actual: ScoutSkillCatalogEntry[],
  expected: ScoutSkillCatalogEntry[],
): boolean {
  return sameValue(actual.map(normalizeSkill), expected.map(normalizeSkill));
}

/** Compares one resolved MCP contract, preserving argument order but not object/root order. */
export function sameMcpServer(
  actual: MaterializedMcpServer,
  expected: MaterializedMcpServer,
): boolean {
  return actual.name === expected.name
    && actual.wrapperPath === expected.wrapperPath
    && actual.command === expected.command
    && sameValue(actual.args, expected.args)
    && actual.cwd === expected.cwd
    && sameValue(actual.env, expected.env)
    && sameUnorderedStrings(actual.trustedRoots, expected.trustedRoots)
    && sameUnorderedStrings(actual.writableRoots, expected.writableRoots)
    && sameValue(actual.smoke, expected.smoke);
}

function normalizeAgentProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    trustedRoots: [...(profile.trustedRoots ?? [])].sort(),
    writableRoots: [...(profile.writableRoots ?? [])].sort(),
  };
}

function normalizeSkill(entry: ScoutSkillCatalogEntry): ScoutSkillCatalogEntry {
  return {
    ...entry,
    phase: [...entry.phase].sort(),
    tags: [...entry.tags].sort(),
  };
}

function countStrings(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

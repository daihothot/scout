import { isDeepStrictEqual } from "node:util";
import type {
  AgentProfile,
} from "../contracts/profile.js";
import type { MaterializedMcpServer } from "../contracts/resources.js";
import { profileResourceProjection } from "../assets/agent-profile.js";

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

/** Compares only resource-bearing profile fields; external root bindings may drift. */
export function sameAgentProfileResources(actual: AgentProfile, expected: AgentProfile): boolean {
  return sameValue(
    profileResourceProjection(actual),
    profileResourceProjection(expected),
  );
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
    && sameUnorderedStrings(actual.writableRoots, expected.writableRoots)
    && sameValue(actual.smoke, expected.smoke);
}

function normalizeAgentProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    readableRoots: [...(profile.readableRoots ?? [])].sort(),
    writableRoots: [...(profile.writableRoots ?? [])].sort(),
  };
}

function countStrings(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

import { readFileSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import {
  ScoutAgentPhases,
  type ScoutAgentPhase,
} from "../../agent/thread/types.js";

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

interface FrontmatterField {
  path: string[];
  value: string;
}

const SKILL_TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOUT_AGENT_PHASES = new Set<ScoutAgentPhase>(Object.values(ScoutAgentPhases));

/** Reads selected Skill files, parses their metadata, and validates the complete catalog. */
export function buildScoutSkillCatalog(input: {
  assetsRoot: string;
  skillPaths: string[];
}): ScoutSkillCatalogEntry[] {
  const catalog = input.skillPaths.map((skillPath) => {
    const sourcePath = join(input.assetsRoot, skillPath);
    const expectedName = basename(dirname(sourcePath));
    return parseScoutSkillMetadata({
      text: readFileSync(sourcePath, "utf8"),
      expectedName,
      sourcePath,
    });
  });
  validateScoutSkillCatalog(catalog);
  return catalog;
}

/** Parses one Skill frontmatter block and rejects legacy or inconsistent metadata. */
export function parseScoutSkillMetadata(input: {
  text: string;
  expectedName: string;
  sourcePath?: string;
}): ScoutSkillCatalogEntry {
  const label = input.sourcePath ?? input.expectedName;
  const frontmatter = extractFrontmatter(input.text, label);
  const fields = parseFrontmatterFields(frontmatter, label);
  const assetKind = requireScalar(fields, ["assetKind"], label);
  const name = requireScalar(fields, ["name"], label);
  const id = requireScalar(fields, ["id"], label);
  const description = requireScalar(fields, ["description"], label);
  const summary = requireScalar(fields, ["summary"], label);
  if (assetKind !== "scout.skill") {
    throw new Error(`Scout Skill ${label} assetKind must be scout.skill.`);
  }
  if (name !== input.expectedName || id !== input.expectedName) {
    throw new Error(`Scout Skill ${label} name and id must match ${input.expectedName}.`);
  }

  const phase = requireTokenList(fields, ["phase"], label).map((value) => {
    if (!SCOUT_AGENT_PHASES.has(value as ScoutAgentPhase)) {
      throw new Error(`Scout Skill ${label} has unsupported phase: ${value}`);
    }
    return value as ScoutAgentPhase;
  });
  if (findField(fields, ["domain"])) {
    throw new Error(`Scout Skill ${label} must use family instead of legacy domain metadata.`);
  }
  const family = optionalNonEmptyTokenList(fields, ["family"], label);
  const tags = requireTokenList(fields, ["tags"], label);
  const requiredSkills = optionalTokenList(
    fields,
    ["dependencies", "skills", "required"],
    label,
  );

  return {
    name,
    description,
    summary,
    phase,
    ...(family === undefined ? {} : { family }),
    tags,
    requiredSkills,
    path: posix.join(".scout", "skills", name, "SKILL.md"),
  };
}

/** Returns selected Skills in dependency-first order and rejects cycles or unknown names. */
export function resolveSkillDependencyLoadOrder(
  catalog: ScoutSkillCatalogEntry[],
  selectedNames: string[],
): ScoutSkillCatalogEntry[] {
  const byName = new Map(catalog.map((skill) => [skill.name, skill] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: ScoutSkillCatalogEntry[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Scout Skill dependency cycle contains ${name}.`);
    }
    const skill = byName.get(name);
    if (!skill) throw new Error(`Unknown Scout Skill dependency: ${name}`);
    visiting.add(name);
    for (const dependency of skill.requiredSkills) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    result.push(skill);
  };

  for (const name of selectedNames) visit(name);
  return result;
}

/** Validates names, phase compatibility, dependency closure, and family routing constraints. */
export function validateScoutSkillCatalog(catalog: ScoutSkillCatalogEntry[]): void {
  const names = new Set<string>();
  for (const skill of catalog) {
    if (names.has(skill.name)) {
      throw new Error(`Duplicate Scout Skill catalog entry: ${skill.name}`);
    }
    names.add(skill.name);
  }
  const byName = new Map(catalog.map((skill) => [skill.name, skill] as const));
  for (const skill of catalog) {
    for (const dependencyName of skill.requiredSkills) {
      const dependency = byName.get(dependencyName);
      if (!dependency) {
        throw new Error(`Unknown Scout Skill dependency: ${dependencyName}`);
      }
      const unsupportedPhase = skill.phase.find((phase) =>
        !dependency.phase.includes(phase)
      );
      if (unsupportedPhase) {
        throw new Error(
          `Scout Skill ${skill.name} dependency ${dependencyName} does not support phase ${unsupportedPhase}.`,
        );
      }
    }
  }
  resolveSkillDependencyLoadOrder(catalog, catalog.map((skill) => skill.name));
  validateRoutableFamilyLeaves(catalog);
  validateDependencyOnlySkillReachability(catalog);
}

/** Extracts the YAML-like frontmatter section required by every Scout Skill. */
function extractFrontmatter(text: string, label: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) throw new Error(`Scout Skill ${label} must contain YAML frontmatter.`);
  return match[1];
}

/** Parses nested scalar field paths while rejecting tabs and duplicate declarations. */
function parseFrontmatterFields(frontmatter: string, label: string): FrontmatterField[] {
  const fields: FrontmatterField[] = [];
  const fieldPaths = new Set<string>();
  const parents: Array<{ indent: number; key: string }> = [];
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) continue;
    if (/^\s*\t/.test(rawLine)) {
      throw new Error(`Scout Skill ${label} frontmatter must use spaces for indentation.`);
    }
    const match = /^( *)([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?$/.exec(rawLine);
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    const key = match[2] ?? "";
    const value = match[3] ?? "";
    while (parents.length > 0 && (parents.at(-1)?.indent ?? -1) >= indent) {
      parents.pop();
    }
    const path = [...parents.map((parent) => parent.key), key];
    const serializedPath = path.join(".");
    if (fieldPaths.has(serializedPath)) {
      throw new Error(`Scout Skill ${label} frontmatter contains duplicate field: ${serializedPath}`);
    }
    fieldPaths.add(serializedPath);
    fields.push({ path, value });
    if (value.length === 0) parents.push({ indent, key });
  }
  return fields;
}

function requireScalar(fields: FrontmatterField[], path: string[], label: string): string {
  const field = findField(fields, path);
  const value = field ? unquote(field.value.trim()) : "";
  if (value.length === 0) {
    throw new Error(`Scout Skill ${label} must define ${path.join(".")}.`);
  }
  return value;
}

function requireTokenList(fields: FrontmatterField[], path: string[], label: string): string[] {
  const values = optionalTokenList(fields, path, label);
  if (values.length === 0) {
    throw new Error(`Scout Skill ${label} must define non-empty ${path.join(".")}.`);
  }
  return values;
}

function optionalNonEmptyTokenList(
  fields: FrontmatterField[],
  path: string[],
  label: string,
): string[] | undefined {
  if (!findField(fields, path)) return undefined;
  return requireTokenList(fields, path, label);
}

function optionalTokenList(fields: FrontmatterField[], path: string[], label: string): string[] {
  const field = findField(fields, path);
  if (!field) return [];
  const text = field.value.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) {
    throw new Error(`Scout Skill ${label} ${path.join(".")} must be an inline list.`);
  }
  const body = text.slice(1, -1).trim();
  if (body.length === 0) return [];
  const values = body.split(",").map((value) => unquote(value.trim()));
  const seen = new Set<string>();
  for (const value of values) {
    if (!SKILL_TOKEN_PATTERN.test(value)) {
      throw new Error(`Scout Skill ${label} ${path.join(".")} has invalid token: ${value}`);
    }
    if (seen.has(value)) {
      throw new Error(`Scout Skill ${label} ${path.join(".")} contains duplicate token: ${value}`);
    }
    seen.add(value);
  }
  return values;
}

function findField(fields: FrontmatterField[], path: string[]): FrontmatterField | undefined {
  return fields.find((field) =>
    field.path.length === path.length && field.path.every((part, index) => part === path[index])
  );
}

function unquote(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function validateRoutableFamilyLeaves(catalog: ScoutSkillCatalogEntry[]): void {
  const familyPaths = uniqueFamilyPaths(catalog);
  for (const family of familyPaths) {
    const descendant = familyPaths.find((candidate) =>
      candidate.length > family.length && familyPrefixMatches(candidate, family)
    );
    if (descendant) {
      throw new Error(
        `Scout Skill family ${formatFamily(family)} must be a leaf and cannot prefix ${formatFamily(descendant)}.`,
      );
    }
  }
}

function validateDependencyOnlySkillReachability(catalog: ScoutSkillCatalogEntry[]): void {
  const dependencyOnlySkills = catalog.filter((skill) => skill.family === undefined);
  if (dependencyOnlySkills.length === 0) return;

  const byName = new Map(catalog.map((skill) => [skill.name, skill] as const));
  const reachableDependencies = new Set<string>();
  const visit = (name: string): void => {
    if (reachableDependencies.has(name)) return;
    reachableDependencies.add(name);
    const skill = byName.get(name);
    if (!skill) return;
    for (const dependencyName of skill.requiredSkills) visit(dependencyName);
  };
  for (const entry of catalog) {
    if (entry.family === undefined) continue;
    for (const dependencyName of entry.requiredSkills) visit(dependencyName);
  }

  for (const skill of dependencyOnlySkills) {
    if (!reachableDependencies.has(skill.name)) {
      throw new Error(
        `Scout Skill ${skill.name} has no family and is unreachable from every routable Skill dependency closure.`,
      );
    }
  }
}

function uniqueFamilyPaths(catalog: ScoutSkillCatalogEntry[]): string[][] {
  const paths = new Map<string, string[]>();
  for (const skill of catalog) {
    if (skill.family === undefined) continue;
    const key = skill.family.join("\0");
    if (!paths.has(key)) paths.set(key, skill.family);
  }
  return [...paths.values()];
}

function familyPrefixMatches(family: string[], prefix: string[]): boolean {
  return prefix.every((token, index) => family[index] === token);
}

function formatFamily(family: string[]): string {
  return `[${family.join(", ")}]`;
}

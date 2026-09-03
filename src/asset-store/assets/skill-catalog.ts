import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  posix,
  relative,
  sep,
  win32,
} from "node:path";
import type { ScoutAgentPhase } from "../../agent/thread/types.js";
import { InternalPhase } from "../../core/workflow/index.js";
import {
  ScoutSkillResourceRequirements,
  ScoutSkillTypes,
  type ResolvedScoutSkillCatalogEntry,
  type ScoutSkillCatalogEntry,
  type ScoutSkillFamilyPath,
  type ScoutSkillResourceCatalogEntry,
  type ScoutSkillResourceRequirement,
  type ScoutSkillType,
} from "../contracts/skill.js";

interface FrontmatterField {
  path: string[];
  value: string;
  lineIndex: number;
  indent: number;
}

const SKILL_TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_FAMILY_SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*";
const SKILL_FAMILY_SELECTOR_PATTERN = new RegExp(
  `^family:${SKILL_FAMILY_SEGMENT}(?:\\.${SKILL_FAMILY_SEGMENT})*\\.(?:\\*|\\*\\*)$`,
);
const SKILL_DEPENDENCY_PATTERN = new RegExp(
  `^(?:${SKILL_TOKEN_PATTERN.source.slice(1, -1)}|${SKILL_FAMILY_SELECTOR_PATTERN.source.slice(1, -1)})$`,
);
const SCOUT_SKILL_RESOURCE_REQUIREMENTS = new Set<ScoutSkillResourceRequirement>(
  Object.values(ScoutSkillResourceRequirements),
);
const SKILL_RESOURCE_ROOTS = ["templates", "references"] as const;
const MAX_SKILL_RESOURCE_PATH_LENGTH = 512;

/** Lists every authored Skill entry point under the Scout asset root. */
export function listScoutSkillPaths(assetsRoot: string): string[] {
  const skillsRoot = join(assetsRoot, "skills");
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("skills", entry.name, "SKILL.md"))
    .filter((path) => existsSync(join(assetsRoot, path)))
    .sort();
}

/** Reads selected Skill files, parses their metadata, and validates the complete catalog. */
export function buildScoutSkillCatalog(input: {
  assetsRoot: string;
  skillPaths: string[];
}): ScoutSkillCatalogEntry[] {
  const catalog = input.skillPaths.map((skillPath) => {
    const sourcePath = join(input.assetsRoot, skillPath);
    const expectedName = basename(dirname(sourcePath));
    const resources = buildScoutSkillResourceCatalog(dirname(sourcePath));
    return parseScoutSkillMetadata({
      text: readFileSync(sourcePath, "utf8"),
      expectedName,
      sourcePath,
      resources,
    });
  });
  validateScoutSkillCatalog(catalog);
  return catalog;
}

/** Parses the runtime metadata needed to project and load one Skill. */
export function parseScoutSkillMetadata(input: {
  text: string;
  expectedName: string;
  sourcePath?: string;
  resources: ScoutSkillResourceCatalogEntry[];
}): ScoutSkillCatalogEntry {
  const label = input.sourcePath ?? input.expectedName;
  const frontmatter = extractFrontmatter(input.text, label);
  const fields = parseFrontmatterFields(frontmatter, label);
  const assetKind = requireScalar(fields, ["assetKind"], label);
  const name = requireScalar(fields, ["name"], label);
  const type = requireScalar(fields, ["type"], label);
  const id = requireScalar(fields, ["id"], label);
  const description = requireScalar(fields, ["description"], label);
  const summary = requireScalar(fields, ["summary"], label);
  if (assetKind !== "scout.skill") {
    throw new Error(`Scout Skill ${label} assetKind must be scout.skill.`);
  }
  if (name !== input.expectedName || id !== input.expectedName) {
    throw new Error(`Scout Skill ${label} name and id must match ${input.expectedName}.`);
  }
  if (!Object.values(ScoutSkillTypes).includes(type as ScoutSkillType)) {
    throw new Error(`Scout Skill ${label} has unsupported type: ${type}`);
  }
  const parsedType = type as ScoutSkillType;
  const domain = parsedType === ScoutSkillTypes.Domain
    ? requireScalar(fields, ["domain"], label)
    : undefined;
  if (domain !== undefined && !SKILL_TOKEN_PATTERN.test(domain)) {
    throw new Error(`Scout Skill ${label} domain has invalid token: ${domain}`);
  }
  const phaseField = findField(fields, ["phase"]);
  const phase = phaseField
    ? parseInlineList(phaseField, label, /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/)
    : undefined;
  const family = requireTokenList(fields, ["family"], label);
  const tags = requireTokenList(fields, ["tags"], label);
  const requiredDependencies = optionalSkillDependencies(
    fields,
    ["dependencies", "skills", "required"],
    label,
  );
  const optionalDependencies = optionalSkillDependencies(
    fields,
    ["dependencies", "skills", "optional"],
    label,
  );

  return {
    name,
    type: parsedType,
    ...(domain ? { domain } : {}),
    description,
    summary,
    phase,
    family,
    tags,
    requiredSkills: requiredDependencies.skills,
    optionalSkills: optionalDependencies.skills,
    requiredFamilyPaths: requiredDependencies.familyPaths,
    optionalFamilyPaths: optionalDependencies.familyPaths,
    path: posix.join(".scout", "skill", ...family, name, "SKILL.md"),
    resources: input.resources,
  };
}

/** Parses the namespaced metadata owned by one supplementary Markdown resource. */
export function parseScoutSkillResourceMetadata(input: {
  text: string;
  path: string;
  sourcePath?: string;
}): ScoutSkillResourceCatalogEntry {
  return parseScoutSkillResourceDocument(input);
}

function parseScoutSkillResourceDocument(input: {
  text: string;
  path: string;
  sourcePath?: string;
}): ScoutSkillResourceCatalogEntry {
  const path = validateSkillResourcePath(input.path, input.sourcePath ?? input.path);
  const label = `resource ${input.sourcePath ?? path}`;
  const fields = parseFrontmatterFields(extractFrontmatter(input.text, label), label);
  const requirement = requireScalar(
    fields,
    ["scout", "resource", "requirement"],
    label,
  );
  if (!SCOUT_SKILL_RESOURCE_REQUIREMENTS.has(requirement as ScoutSkillResourceRequirement)) {
    throw new Error(
      `Scout Skill ${label} has unsupported scout.resource.requirement: ${requirement}`,
    );
  }
  const description = requireScalar(
    fields,
    ["scout", "resource", "description"],
    label,
  );
  return {
    path,
    requirement: requirement as ScoutSkillResourceRequirement,
    description,
  };
}

/** Returns selected Skills in dependency-first order and rejects cycles or unknown names. */
export function resolveSkillDependencyLoadOrder(
  catalog: ScoutSkillCatalogEntry[],
  selectedNames: string[],
): ResolvedScoutSkillCatalogEntry[] {
  const byName = new Map(catalog.map((skill) => [skill.name, skill] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: ResolvedScoutSkillCatalogEntry[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Scout Skill dependency cycle contains ${name}.`);
    }
    const skill = byName.get(name);
    if (!skill) throw new Error(`Unknown Scout Skill dependency: ${name}`);
    visiting.add(name);
    const resolvedRequiredSkills = resolveDirectSkillDependencies(
      catalog,
      skill,
      "required",
      true,
    );
    const resolvedOptionalSkills = resolveDirectSkillDependencies(
      catalog,
      skill,
      "optional",
      true,
    );
    for (const dependency of resolvedRequiredSkills) visit(dependency);
    for (const dependency of resolvedOptionalSkills) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    result.push({
      ...skill,
      resolvedRequiredSkills,
      resolvedOptionalSkills,
    });
  };

  for (const name of selectedNames) visit(name);
  return result;
}

/** Returns Internal Skills and current-domain Skills visible in the supplied Phases. */
export function resolveScoutSkillsForPhases(
  catalog: ScoutSkillCatalogEntry[],
  input: {
    domain: string;
    phases: readonly ScoutAgentPhase[];
  },
): ResolvedScoutSkillCatalogEntry[] {
  const selectedPhases = new Set(input.phases);
  return resolveSkillDependencyLoadOrder(
    catalog,
    catalog
      .filter((skill) => {
        if (skill.type === ScoutSkillTypes.Internal) {
          return skill.phase?.includes(InternalPhase) === true;
        }
        return skill.type === ScoutSkillTypes.Domain
          && skill.domain === input.domain
          && skill.phase?.some((phase) => selectedPhases.has(phase)) === true;
      })
      .map((skill) => skill.name),
  );
}

/** Rejects dependency cycles without enforcing authoring relationships. */
export function validateScoutSkillCatalog(catalog: ScoutSkillCatalogEntry[]): void {
  const byName = new Map(catalog.map((skill) => [skill.name, skill] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (skill: ScoutSkillCatalogEntry): void => {
    if (visited.has(skill.name)) return;
    if (visiting.has(skill.name)) {
      throw new Error(`Scout Skill dependency cycle contains ${skill.name}.`);
    }
    visiting.add(skill.name);
    const dependencies = [
      ...resolveDirectSkillDependencies(catalog, skill, "required", false),
      ...resolveDirectSkillDependencies(catalog, skill, "optional", false),
    ];
    for (const dependencyName of dependencies) {
      const dependency = byName.get(dependencyName);
      if (dependency) visit(dependency);
    }
    visiting.delete(skill.name);
    visited.add(skill.name);
  };

  for (const skill of catalog) visit(skill);
}

function buildScoutSkillResourceCatalog(skillRoot: string): ScoutSkillResourceCatalogEntry[] {
  const resources: ScoutSkillResourceCatalogEntry[] = [];
  const paths = new Set<string>();

  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const sourcePath = join(directory, name);
      const stat = lstatSync(sourcePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Scout Skill resource path must not be a symbolic link: ${sourcePath}`);
      }
      if (stat.isDirectory()) {
        visit(sourcePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Scout Skill resource path must be a regular file: ${sourcePath}`);
      }
      if (extname(name) !== ".md") continue;

      const resourcePath = relative(skillRoot, sourcePath).split(sep).join(posix.sep);
      const resource = parseScoutSkillResourceMetadata({
        text: readFileSync(sourcePath, "utf8"),
        path: resourcePath,
        sourcePath,
      });
      if (paths.has(resource.path)) {
        throw new Error(`Duplicate Scout Skill resource path: ${resource.path}`);
      }
      paths.add(resource.path);
      resources.push(resource);
    }
  };

  for (const rootName of SKILL_RESOURCE_ROOTS) {
    const resourceRoot = join(skillRoot, rootName);
    if (!existsSync(resourceRoot)) continue;
    const stat = lstatSync(resourceRoot);
    if (stat.isSymbolicLink()) {
      throw new Error(`Scout Skill resource root must not be a symbolic link: ${resourceRoot}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Scout Skill resource root must be a directory: ${resourceRoot}`);
    }
    visit(resourceRoot);
  }
  return resources.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

function validateSkillResourcePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Scout Skill ${label} must define a resource path.`);
  }
  if (value.length > MAX_SKILL_RESOURCE_PATH_LENGTH) {
    throw new Error(
      `Scout Skill ${label} resource path exceeds ${MAX_SKILL_RESOURCE_PATH_LENGTH} characters.`,
    );
  }
  if (
    value.includes("\0")
    || value.includes("\\")
    || posix.isAbsolute(value)
    || win32.isAbsolute(value)
  ) {
    throw new Error(`Scout Skill ${label} resource path must be a POSIX relative path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(
      `Scout Skill ${label} resource path cannot contain empty, dot, or parent segments.`,
    );
  }
  if (!SKILL_RESOURCE_ROOTS.includes(segments[0] as typeof SKILL_RESOURCE_ROOTS[number])) {
    throw new Error(
      `Scout Skill ${label} resource path must be under templates/ or references/.`,
    );
  }
  if (posix.extname(value) !== ".md" || posix.normalize(value) !== value) {
    throw new Error(`Scout Skill ${label} resource path must be a normalized Markdown path.`);
  }
  return value;
}

/** Extracts the YAML-like frontmatter section required by every Scout Skill. */
function extractFrontmatter(text: string, label: string): string {
  const match = /^(---)(\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  const frontmatter = match?.[3];
  if (!match || !frontmatter) {
    throw new Error(`Scout Skill ${label} must contain YAML frontmatter.`);
  }
  return frontmatter;
}

/** Parses nested scalar field paths while rejecting tabs and duplicate declarations. */
function parseFrontmatterFields(frontmatter: string, label: string): FrontmatterField[] {
  const fields: FrontmatterField[] = [];
  const fieldPaths = new Set<string>();
  const parents: Array<{ indent: number; key: string }> = [];
  for (const [lineIndex, rawLine] of frontmatter.split(/\r?\n/).entries()) {
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
    fields.push({ path, value, lineIndex, indent });
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

function optionalTokenList(fields: FrontmatterField[], path: string[], label: string): string[] {
  const field = findField(fields, path);
  if (!field) return [];
  return parseInlineList(field, label, SKILL_TOKEN_PATTERN);
}

function optionalSkillDependencies(
  fields: FrontmatterField[],
  path: string[],
  label: string,
): { skills: string[]; familyPaths: ScoutSkillFamilyPath[] } {
  const field = findField(fields, path);
  if (!field) return { skills: [], familyPaths: [] };
  const declarations = parseInlineList(field, label, SKILL_DEPENDENCY_PATTERN);
  const skills: string[] = [];
  const familyPaths: ScoutSkillFamilyPath[] = [];
  for (const declaration of declarations) {
    if (!declaration.startsWith("family:")) {
      skills.push(declaration);
      continue;
    }
    const separator = declaration.lastIndexOf(".");
    familyPaths.push({
      family: declaration.slice("family:".length, separator).split("."),
      wildcard: declaration.slice(separator + 1) as "*" | "**",
    });
  }
  return { skills, familyPaths };
}

function resolveDirectSkillDependencies(
  catalog: ScoutSkillCatalogEntry[],
  skill: ScoutSkillCatalogEntry,
  requirement: "required" | "optional",
  rejectEmptyRequiredPath: boolean,
): string[] {
  const byName = new Set(catalog.map((candidate) => candidate.name));
  const names = requirement === "required"
    ? [...skill.requiredSkills]
    : skill.optionalSkills.filter((name) => byName.has(name));
  const familyPaths = requirement === "required"
    ? skill.requiredFamilyPaths
    : skill.optionalFamilyPaths;

  for (const familyPath of familyPaths) {
    const matches = catalog
      .filter((candidate) => matchesFamilyPath(candidate.family, familyPath))
      .sort((left, right) => {
        const leftFamily = left.family.join(".");
        const rightFamily = right.family.join(".");
        if (leftFamily !== rightFamily) return leftFamily < rightFamily ? -1 : 1;
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
      });
    if (requirement === "required" && rejectEmptyRequiredPath && matches.length === 0) {
      const missingPath = [...familyPath.family, familyPath.wildcard].join(".");
      throw new Error(
        `Scout Skill ${skill.name} required family path has no matches: ${missingPath}`,
      );
    }
    names.push(...matches.map((candidate) => candidate.name));
  }

  return [...new Set(names)];
}

function matchesFamilyPath(
  family: readonly string[],
  familyPath: ScoutSkillFamilyPath,
): boolean {
  if (!familyPath.family.every((segment, index) => family[index] === segment)) return false;
  return familyPath.wildcard === "**"
    ? family.length >= familyPath.family.length
    : family.length === familyPath.family.length + 1;
}

function parseInlineList(
  field: FrontmatterField,
  label: string,
  tokenPattern: RegExp,
): string[] {
  const text = field.value.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) {
    throw new Error(`Scout Skill ${label} ${field.path.join(".")} must be an inline list.`);
  }
  const body = text.slice(1, -1).trim();
  if (body.length === 0) return [];
  const values = body.split(",").map((value) => unquote(value.trim()));
  const seen = new Set<string>();
  for (const value of values) {
    if (!tokenPattern.test(value)) {
      throw new Error(`Scout Skill ${label} ${field.path.join(".")} has invalid token: ${value}`);
    }
    if (seen.has(value)) {
      throw new Error(`Scout Skill ${label} ${field.path.join(".")} contains duplicate token: ${value}`);
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

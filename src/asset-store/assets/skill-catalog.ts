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
import {
  ScoutSkillResourceRequirements,
  type ScoutSkillCatalogEntry,
  type ScoutSkillResourceCatalogEntry,
  type ScoutSkillResourceRequirement,
} from "../contracts/skill.js";

interface FrontmatterField {
  path: string[];
  value: string;
  lineIndex: number;
  indent: number;
}

const SKILL_TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

/** Parses one Skill frontmatter block and validates current metadata. */
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
  const id = requireScalar(fields, ["id"], label);
  const description = requireScalar(fields, ["description"], label);
  const summary = requireScalar(fields, ["summary"], label);
  if (assetKind !== "scout.skill") {
    throw new Error(`Scout Skill ${label} assetKind must be scout.skill.`);
  }
  if (name !== input.expectedName || id !== input.expectedName) {
    throw new Error(`Scout Skill ${label} name and id must match ${input.expectedName}.`);
  }

  if (!findField(fields, ["phase"])) {
    throw new Error(`Scout Skill ${label} must define phase.`);
  }
  const phaseField = findField(fields, ["phase"]);
  const phase = phaseField
    ? parseInlineList(phaseField, label, /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/)
    : [];
  const family = requireTokenList(fields, ["family"], label);
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
    family,
    tags,
    requiredSkills,
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

/** Returns all Skills visible in the supplied Phases plus their required dependency closure. */
export function resolveScoutSkillsForPhases(
  catalog: ScoutSkillCatalogEntry[],
  phases: readonly ScoutAgentPhase[],
): ScoutSkillCatalogEntry[] {
  const selectedPhases = new Set(phases);
  return resolveSkillDependencyLoadOrder(
    catalog,
    catalog
      .filter((skill) => skill.phase.some((phase) => selectedPhases.has(phase)))
      .map((skill) => skill.name),
  );
}

/** Validates names, resources, phase compatibility, and dependency closure. */
export function validateScoutSkillCatalog(catalog: ScoutSkillCatalogEntry[]): void {
  const names = new Set<string>();
  for (const skill of catalog) {
    if (names.has(skill.name)) {
      throw new Error(`Duplicate Scout Skill catalog entry: ${skill.name}`);
    }
    names.add(skill.name);
    validateSkillResources(skill);
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

function validateSkillResources(skill: ScoutSkillCatalogEntry): void {
  if (!Array.isArray(skill.resources)) {
    throw new Error(`Scout Skill ${skill.name} must define resources.`);
  }
  const paths = new Set<string>();
  for (const resource of skill.resources) {
    if (!resource || typeof resource !== "object") {
      throw new Error(`Scout Skill ${skill.name} contains an invalid resource entry.`);
    }
    const path = validateSkillResourcePath(
      resource.path,
      `${skill.name} resource catalog entry`,
    );
    if (paths.has(path)) {
      throw new Error(`Scout Skill ${skill.name} contains duplicate resource path: ${path}`);
    }
    paths.add(path);
    if (!SCOUT_SKILL_RESOURCE_REQUIREMENTS.has(resource.requirement)) {
      throw new Error(
        `Scout Skill ${skill.name} resource ${path} has unsupported requirement: ${String(resource.requirement)}`,
      );
    }
    if (typeof resource.description !== "string" || resource.description.trim().length === 0) {
      throw new Error(`Scout Skill ${skill.name} resource ${path} must define description.`);
    }
  }
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

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
import {
  ScoutAgentPhases,
  type ScoutAgentPhase,
} from "../../agent/thread/types.js";
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

interface FrontmatterLine {
  text: string;
  ending: string;
}

interface FrontmatterDocument {
  frontmatter: string;
  opening: string;
  closing: string;
  remainder: string;
  lines: FrontmatterLine[];
}

const SKILL_TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOUT_AGENT_PHASES = new Set<ScoutAgentPhase>(Object.values(ScoutAgentPhases));
const SCOUT_SKILL_RESOURCE_REQUIREMENTS = new Set<ScoutSkillResourceRequirement>(
  Object.values(ScoutSkillResourceRequirements),
);
const SKILL_RESOURCE_ROOTS = ["templates", "references"] as const;
const MAX_SKILL_RESOURCE_PATH_LENGTH = 512;

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

/** Parses one Skill frontmatter block and rejects legacy or inconsistent metadata. */
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
  const phase = optionalTokenList(fields, ["phase"], label).map((value) => {
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
    resources: input.resources,
  };
}

/** Parses the namespaced metadata owned by one supplementary Markdown resource. */
export function parseScoutSkillResourceMetadata(input: {
  text: string;
  path: string;
  sourcePath?: string;
}): ScoutSkillResourceCatalogEntry {
  return parseScoutSkillResourceDocument(input).metadata;
}

/** Removes runtime-owned control metadata after proving it matches the catalog entry. */
export function projectScoutSkillResourceText(input: {
  text: string;
  path: string;
  expected: ScoutSkillResourceCatalogEntry;
  sourcePath?: string;
}): string {
  const parsed = parseScoutSkillResourceDocument({
    text: input.text,
    path: input.path,
    sourcePath: input.sourcePath,
  });
  const expectedPath = validateSkillResourcePath(
    input.expected.path,
    `${input.sourcePath ?? input.expected.path} catalog entry`,
  );
  if (parsed.metadata.path !== expectedPath) {
    throw new Error(
      `Scout Skill ${parsed.label} path does not match its catalog entry: expected ${expectedPath}, actual ${parsed.metadata.path}.`,
    );
  }
  if (parsed.metadata.requirement !== input.expected.requirement) {
    throw new Error(
      `Scout Skill ${parsed.label} requirement does not match its catalog entry: expected ${input.expected.requirement}, actual ${parsed.metadata.requirement}.`,
    );
  }
  if (parsed.metadata.description !== input.expected.description) {
    throw new Error(
      `Scout Skill ${parsed.label} description does not match its catalog entry.`,
    );
  }

  const scoutField = findField(parsed.fields, ["scout"]);
  const resourceField = findField(parsed.fields, ["scout", "resource"]);
  if (!scoutField || !resourceField) {
    throw new Error(`Scout Skill ${parsed.label} control metadata cannot be projected.`);
  }
  const subtreeEnd = (field: FrontmatterField): number => {
    for (let index = field.lineIndex + 1; index < parsed.document.lines.length; index += 1) {
      const line = parsed.document.lines[index]?.text ?? "";
      if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
      const indent = /^( *)/.exec(line)?.[1]?.length ?? 0;
      if (indent <= field.indent) return index;
    }
    return parsed.document.lines.length;
  };
  const resourceEnd = subtreeEnd(resourceField);
  const scoutEnd = subtreeEnd(scoutField);
  const scoutHasRemainingContent = parsed.document.lines.some((line, index) =>
    index > scoutField.lineIndex
    && index < scoutEnd
    && (index < resourceField.lineIndex || index >= resourceEnd)
    && line.text.trim().length > 0
    && !line.text.trimStart().startsWith("#")
  );
  const removeStart = scoutHasRemainingContent ? resourceField.lineIndex : scoutField.lineIndex;
  const removeEnd = scoutHasRemainingContent ? resourceEnd : scoutEnd;
  const projectedFrontmatter = parsed.document.lines
    .filter((_, index) => index < removeStart || index >= removeEnd)
    .map((line) => line.text + line.ending)
    .join("");
  return parsed.document.opening
    + projectedFrontmatter
    + parsed.document.closing
    + parsed.document.remainder;
}

function parseScoutSkillResourceDocument(input: {
  text: string;
  path: string;
  sourcePath?: string;
}): {
  metadata: ScoutSkillResourceCatalogEntry;
  label: string;
  document: FrontmatterDocument;
  fields: FrontmatterField[];
} {
  const path = validateSkillResourcePath(input.path, input.sourcePath ?? input.path);
  const label = `resource ${input.sourcePath ?? path}`;
  const document = extractFrontmatterDocument(input.text, label);
  const fields = parseFrontmatterFields(document.frontmatter, label);
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
    metadata: {
      path,
      requirement: requirement as ScoutSkillResourceRequirement,
      description,
    },
    label,
    document,
    fields,
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
  validateRoutableFamilyLeaves(catalog);
  validateDependencyOnlySkillReachability(catalog);
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
  return extractFrontmatterDocument(text, label).frontmatter;
}

function extractFrontmatterDocument(text: string, label: string): FrontmatterDocument {
  const match = /^(---)(\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  const frontmatter = match?.[3];
  if (!match || !frontmatter) {
    throw new Error(`Scout Skill ${label} must contain YAML frontmatter.`);
  }
  return {
    frontmatter,
    opening: (match[1] ?? "---") + (match[2] ?? "\n"),
    closing: match[4] ?? "\n---\n",
    remainder: text.slice(match[0].length),
    lines: splitFrontmatterLines(frontmatter),
  };
}

function splitFrontmatterLines(frontmatter: string): FrontmatterLine[] {
  const lines: FrontmatterLine[] = [];
  const newlinePattern = /\r?\n/g;
  let cursor = 0;
  for (const match of frontmatter.matchAll(newlinePattern)) {
    const index = match.index;
    lines.push({
      text: frontmatter.slice(cursor, index),
      ending: match[0],
    });
    cursor = index + match[0].length;
  }
  lines.push({ text: frontmatter.slice(cursor), ending: "" });
  return lines;
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

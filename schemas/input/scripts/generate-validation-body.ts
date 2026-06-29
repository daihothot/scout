import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonValue = string | number | boolean | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

interface ParsedModule {
  module: string;
  imports: Record<string, string[]>;
  exports: Record<string, ExportSchema>;
}

interface FieldSchema {
  type: string;
  required: boolean;
  description?: string;
}

interface ExportSchema {
  kind: "enum" | "interface" | "inline_object";
  description?: string;
  values?: string[];
  fields?: Record<string, FieldSchema>;
}

const SCHEMA_DIR = resolve("schemas/input/validation-body");
const OUTPUT_DIR = resolve("src/input/validation-body");
const BARREL_PATH = resolve("src/input/validation-body.ts");
const STALE_RUNTIME_PATH = resolve("src/input/validation-body-runtime.generated.ts");
const STALE_GENERATEDLESS_FILES = [
  "source-ref.ts",
  "bdd-fact.ts",
  "feature-fact.ts",
  "implementation-fact.ts",
  "requirement-fact.ts",
  "specification-fact.ts",
  "validator-fact.ts",
  "body.ts",
  "validation.ts",
];
const STALE_GENERATED_FILES = [
  "common.generated.ts",
  "goal.generated.ts",
  "context.generated.ts",
  "criteria.generated.ts",
  "facts.generated.ts",
  "scenario.generated.ts",
  "validator-fact.generated.ts",
];
const MODULE_ORDER = [
  "source-ref",
  "catalog",
  "bdd-fact",
  "capability-fact",
  "requirement-fact",
  "specification-fact",
  "feature-fact",
  "implementation-fact",
  "body",
];

const COMPLETENESS_REQUIRED_PATHS = [
  "catalog_ref.uri",
  "bdd_fact.scenario_id",
  "given",
  "when",
  "then",
];

export function generateValidationBodySchema(): void {
  const modules = readSchemaModules();
  const definitions: Record<string, ExportSchema> = {};
  for (const module of modules) {
    for (const [name, declaration] of Object.entries(module.exports)) {
      if (definitions[name]) {
        throw new Error(`Duplicate validation body declaration: ${name}`);
      }
      definitions[name] = declaration;
    }
  }

  if (!definitions.ValidationBody) {
    throw new Error("schemas/input/validation-body must declare ValidationBody.");
  }
  if (!definitions.ValidationCatalog) {
    throw new Error("schemas/input/validation-body must declare ValidationCatalog.");
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const module of modules) {
    writeFileSync(
      join(OUTPUT_DIR, `${module.module}.generated.ts`),
      buildModuleFile(module),
      "utf8",
    );
  }
  writeFileSync(
    join(OUTPUT_DIR, "validation.generated.ts"),
    buildValidationFile(definitions),
    "utf8",
  );
  writeFileSync(BARREL_PATH, buildBarrelFile(modules), "utf8");
  rmSync(STALE_RUNTIME_PATH, { force: true });
  for (const file of STALE_GENERATEDLESS_FILES) {
    rmSync(join(OUTPUT_DIR, file), { force: true });
  }
  for (const file of STALE_GENERATED_FILES) {
    rmSync(join(OUTPUT_DIR, file), { force: true });
  }

  process.stdout.write(`Generated ${modules.length} validation body type files and validation.generated.ts\n`);
}

function readSchemaModules(): ParsedModule[] {
  const files = readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith(".yaml"))
    .sort((left, right) => {
      const leftOrder = MODULE_ORDER.indexOf(basename(left, ".yaml"));
      const rightOrder = MODULE_ORDER.indexOf(basename(right, ".yaml"));
      return normalizeOrder(leftOrder) - normalizeOrder(rightOrder) || left.localeCompare(right);
    });

  return files.map((file) => {
    const parsed = parseYamlObject(readFileSync(join(SCHEMA_DIR, file), "utf8"), file);
    const moduleName = readRequiredString(parsed, "module", file);
    const exportsObject = readObject(parsed.exports, `${file}.exports`);
    return {
      module: moduleName,
      imports: parseImports(parsed.imports),
      exports: parseExports(exportsObject, file),
    };
  });
}

function parseImports(value: JsonValue | undefined): Record<string, string[]> {
  if (value === undefined) return {};
  const importsObject = readObject(value, "imports");
  const result: Record<string, string[]> = {};
  for (const [moduleName, names] of Object.entries(importsObject)) {
    result[moduleName] = readStringArray(names, `imports.${moduleName}`);
  }
  return result;
}

function parseExports(exportsObject: JsonObject, file: string): Record<string, ExportSchema> {
  const result: Record<string, ExportSchema> = {};
  for (const [name, rawDeclaration] of Object.entries(exportsObject)) {
    const declaration = readObject(rawDeclaration, `${file}.exports.${name}`);
    const kind = readRequiredString(declaration, "kind", `${file}.exports.${name}`);
    if (kind !== "enum" && kind !== "interface" && kind !== "inline_object") {
      throw new Error(`${file}.exports.${name}.kind must be enum, interface, or inline_object.`);
    }

    const exportSchema: ExportSchema = {
      kind,
      description: readOptionalString(declaration, "description"),
    };

    if (kind === "enum") {
      exportSchema.values = readStringArray(declaration.values, `${file}.exports.${name}.values`);
    } else {
      exportSchema.fields = parseFields(
        readObject(declaration.fields, `${file}.exports.${name}.fields`),
        `${file}.exports.${name}.fields`,
      );
    }

    result[name] = exportSchema;
  }
  return result;
}

function parseFields(fieldsObject: JsonObject, path: string): Record<string, FieldSchema> {
  const result: Record<string, FieldSchema> = {};
  for (const [fieldName, rawField] of Object.entries(fieldsObject)) {
    const field = readObject(rawField, `${path}.${fieldName}`);
    result[fieldName] = {
      type: String(field.type),
      required: readRequiredBoolean(field, "required", `${path}.${fieldName}`),
      description: readOptionalString(field, "description"),
    };
  }
  return result;
}

function buildModuleFile(module: ParsedModule): string {
  const imports = Object.entries(module.imports)
    .map(([moduleName, names]) => `import type { ${names.join(", ")} } from "./${moduleName}.generated.js";`)
    .join("\n");
  const exports = Object.entries(module.exports)
    .map(([name, declaration]) => renderExport(name, declaration))
    .join("\n\n");
  return [
    generatedHeader(),
    imports,
    imports.length > 0 ? "" : undefined,
    exports,
    "",
  ].filter((line) => line !== undefined).join("\n");
}

function renderExport(name: string, declaration: ExportSchema): string {
  if (declaration.kind === "enum") {
    const values = declaration.values ?? [];
    return [
      renderComment(declaration.description),
      `export type ${name} =`,
      values.map((value) => `  | ${JSON.stringify(value)}`).join("\n"),
      ";",
    ].filter(Boolean).join("\n");
  }

  const fields = Object.entries(declaration.fields ?? {})
    .map(([fieldName, field]) => renderField(fieldName, field))
    .join("\n");
  return [
    renderComment(declaration.description),
    `export interface ${name} {`,
    fields,
    "}",
  ].filter(Boolean).join("\n");
}

function renderField(fieldName: string, field: FieldSchema): string {
  return [
    renderComment(field.description, "  "),
    `  ${fieldName}${field.required ? "" : "?"}: ${field.type};`,
  ].filter(Boolean).join("\n");
}

function buildValidationFile(definitions: Record<string, ExportSchema>): string {
  return `${generatedHeader()}
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ValidationBody } from "./body.generated.js";
import type { ValidationCatalog } from "./catalog.generated.js";

type FieldSchema = Readonly<{
  type: string;
  required: boolean;
  description?: string;
}>;

type DeclarationSchema = Readonly<{
  kind: "enum" | "interface" | "inline_object";
  description?: string;
  values?: readonly string[];
  fields?: Readonly<Record<string, FieldSchema>>;
}>;

export const validationBodyRuntimeSchema = ${JSON.stringify(definitions, null, 2)} as const satisfies Readonly<Record<string, DeclarationSchema>>;

const schema: Readonly<Record<string, DeclarationSchema>> = validationBodyRuntimeSchema;
const validationBodyCompletenessPaths = ${JSON.stringify(COMPLETENESS_REQUIRED_PATHS, null, 2)} as const;

export function createValidationBodySkeleton(input: {
  validationBodyId: string;
  runId: string;
  createdAt: string;
}): ValidationBody {
  const skeleton = createSkeletonForDeclaration("ValidationBody") as Record<string, unknown>;
  skeleton.validationBodyId = input.validationBodyId;
  skeleton.runId = input.runId;
  skeleton.createdAt = input.createdAt;
  return skeleton as unknown as ValidationBody;
}

export function validateValidationCatalog(value: unknown): string[] {
  const errors: string[] = [];
  validateType(value, "ValidationCatalog", "validationCatalog", errors);
  if (errors.length === 0) {
    validateSemanticConstraints(value, "validationCatalog", errors);
    validateCatalogRefs(value, errors);
  }
  return errors;
}

export function validateValidationBody(value: unknown, catalog?: unknown): string[] {
  const errors: string[] = [];
  validateType(value, "ValidationBody", "validationBody", errors);
  if (errors.length === 0) {
    validateSemanticConstraints(value, "validationBody", errors);
    if (catalog === undefined) {
      errors.push("validationBody.catalog_ref requires a ValidationCatalog for semantic validation.");
    } else {
      validateType(catalog, "ValidationCatalog", "validationCatalog", errors);
      if (errors.length === 0) {
        validateSemanticConstraints(catalog, "validationCatalog", errors);
        validateCatalogRefs(catalog, errors);
        validateValidationBodySemanticRelations(value, catalog, errors);
      }
    }
  }
  if (errors.length === 0 && !validationBodyComplete(value as ValidationBody)) {
    errors.push("validationBody is structurally valid but incomplete for plan build.");
  }
  return errors;
}

export function validationBodyComplete(validationBody: ValidationBody): boolean {
  return validationBodyCompletenessPaths.every((path) => hasNonEmptyValue(readPath(validationBody, path)));
}

function createSkeletonForDeclaration(name: string): unknown {
  const declaration = schema[name];
  if (!declaration) {
    throw new Error(\`Unknown validation body declaration: \${name}\`);
  }
  if (declaration.kind === "enum") {
    return declaration.values?.[0] ?? "";
  }

  const result: Record<string, unknown> = {};
  for (const [fieldName, field] of Object.entries(declaration.fields ?? {})) {
    if (field.required) {
      result[fieldName] = createSkeletonForType(field.type);
    }
  }
  return result;
}

function createSkeletonForType(type: string): unknown {
  const arrayElementType = readArrayElementType(type);
  if (arrayElementType) return [];

  const literalOptions = readLiteralOptions(type);
  if (literalOptions.length > 0) return literalOptions[0];

  if (type === "string") return "";
  if (type === "number") return 0;
  if (type === "boolean") return false;
  if (schema[type]) return createSkeletonForDeclaration(type);

  throw new Error(\`Unsupported validation body skeleton type: \${type}\`);
}

function validateType(value: unknown, type: string, path: string, errors: string[]): void {
  const arrayElementType = readArrayElementType(type);
  if (arrayElementType) {
    if (!Array.isArray(value)) {
      errors.push(\`\${path} must be an array.\`);
      return;
    }
    for (const [index, item] of value.entries()) {
      validateType(item, arrayElementType, \`\${path}[\${index}]\`, errors);
    }
    return;
  }

  const literalOptions = readLiteralOptions(type);
  if (literalOptions.length > 0) {
    if (!literalOptions.includes(value as string | number | boolean)) {
      errors.push(\`\${path} must be \${formatOptions(literalOptions)}.\`);
    }
    return;
  }

  if (type === "string") {
    if (typeof value !== "string" || value.length === 0) {
      errors.push(\`\${path} must be a non-empty string.\`);
    }
    return;
  }

  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(\`\${path} must be a finite number.\`);
    }
    return;
  }

  if (type === "boolean") {
    if (typeof value !== "boolean") {
      errors.push(\`\${path} must be a boolean.\`);
    }
    return;
  }

  const declaration = schema[type];
  if (!declaration) {
    errors.push(\`\${path} uses unknown validation body schema type \${type}.\`);
    return;
  }

  if (declaration.kind === "enum") {
    if (typeof value !== "string" || !(declaration.values ?? []).includes(value)) {
      errors.push(\`\${path} must be one of \${formatOptions(declaration.values ?? [])}.\`);
    }
    return;
  }

  if (!isRecord(value)) {
    errors.push(\`\${path} must be an object.\`);
    return;
  }

  for (const [fieldName, field] of Object.entries(declaration.fields ?? {})) {
    const fieldPath = \`\${path}.\${fieldName}\`;
    if (!(fieldName in value)) {
      if (field.required) {
        errors.push(\`\${fieldPath} is required.\`);
      }
      continue;
    }
    const fieldValue = value[fieldName];
    if (fieldValue === undefined) {
      if (field.required) {
        errors.push(\`\${fieldPath} is required.\`);
      }
      continue;
    }
    validateType(fieldValue, field.type, fieldPath, errors);
  }
}

function validateSemanticConstraints(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateSemanticConstraints(item, \`\${path}[\${index}]\`, errors);
    }
    return;
  }

  if (!isRecord(value)) return;

  if (value.type === "codegraph_symbol") {
    const symbolRefs = value.symbol_refs;
    if (!Array.isArray(symbolRefs) || symbolRefs.length === 0) {
      errors.push(\`\${path}.symbol_refs must be a non-empty array when type is codegraph_symbol.\`);
    }
  }

  for (const [fieldName, fieldValue] of Object.entries(value)) {
    validateSemanticConstraints(fieldValue, \`\${path}.\${fieldName}\`, errors);
  }
}

function validateValidationBodySemanticRelations(value: unknown, catalog: unknown, errors: string[]): void {
  if (!isRecord(value)) return;
  validateBddProjection(value, "given", errors);
  validateBddProjection(value, "when", errors);
  validateBddProjection(value, "then", errors);
  validateCatalogRefMatches(value, catalog, errors);
  validateSourcedClaimRefs(value, catalog, errors);
}

function validateBddProjection(
  validationBody: Record<string, unknown>,
  key: "given" | "when" | "then",
  errors: string[],
): void {
  const topLevel = validationBody[key];
  const bddFact = validationBody.bdd_fact;
  if (!Array.isArray(topLevel) || !isRecord(bddFact) || !Array.isArray(bddFact[key])) return;

  const bddSteps = bddFact[key]
    .map((item) => isRecord(item) && typeof item.text === "string" ? item.text.trim() : "")
    .filter((item) => item.length > 0);
  const topLevelSteps = topLevel
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0);
  if (bddSteps.length === 0 || topLevelSteps.length === 0) return;
  if (JSON.stringify(bddSteps) !== JSON.stringify(topLevelSteps)) {
    errors.push(\`validationBody.\${key} must match validationBody.bdd_fact.\${key}[].text.\`);
  }
}

function validateCatalogRefMatches(validationBody: Record<string, unknown>, catalog: unknown, errors: string[]): void {
  const catalogRef = validationBody.catalog_ref;
  if (!isRecord(catalogRef) || !isRecord(catalog)) return;
  if (catalogRef.catalog_id !== catalog.catalog_id) {
    errors.push(\`validationBody.catalog_ref.catalog_id must match validationCatalog.catalog_id.\`);
  }
}

function validateCatalogRefs(catalog: unknown, errors: string[]): void {
  if (!isRecord(catalog)) return;
  const sourceRefs = catalog.source_refs;
  const evidenceRefs = catalog.evidence_refs;
  const implementationRefs = catalog.implementation_refs;
  const sourceRefIds = new Set<string>();
  const evidenceRefIds = new Set<string>();
  const implementationRefIds = new Set<string>();

  if (Array.isArray(sourceRefs)) {
    for (const [index, item] of sourceRefs.entries()) {
      if (!isRecord(item)) continue;
      const id = item.source_ref_id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      if (sourceRefIds.has(id)) {
        errors.push(\`validationCatalog.source_refs[\${index}].source_ref_id duplicates \${id}.\`);
      }
      sourceRefIds.add(id);
    }
  }

  if (Array.isArray(evidenceRefs)) {
    for (const [index, item] of evidenceRefs.entries()) {
      if (!isRecord(item)) continue;
      const id = item.evidence_ref_id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      if (evidenceRefIds.has(id)) {
        errors.push(\`validationCatalog.evidence_refs[\${index}].evidence_ref_id duplicates \${id}.\`);
      }
      evidenceRefIds.add(id);

      const sourceIds = item.source_ref_ids;
      if (Array.isArray(sourceIds)) {
        for (const sourceId of sourceIds) {
          if (typeof sourceId === "string" && !sourceRefIds.has(sourceId)) {
            errors.push(\`validationCatalog.evidence_refs[\${index}].source_ref_ids references unknown source_ref_id \${sourceId}.\`);
          }
        }
      }
    }
  }

  if (Array.isArray(implementationRefs)) {
    for (const [index, item] of implementationRefs.entries()) {
      if (!isRecord(item)) continue;
      const id = item.implementation_ref_id;
      if (typeof id !== "string" || id.trim().length === 0) continue;
      if (implementationRefIds.has(id)) {
        errors.push(\`validationCatalog.implementation_refs[\${index}].implementation_ref_id duplicates \${id}.\`);
      }
      implementationRefIds.add(id);

      const sourceIds = item.source_ref_ids;
      if (Array.isArray(sourceIds)) {
        for (const sourceId of sourceIds) {
          if (typeof sourceId === "string" && !sourceRefIds.has(sourceId)) {
            errors.push(\`validationCatalog.implementation_refs[\${index}].source_ref_ids references unknown source_ref_id \${sourceId}.\`);
          }
        }
      }
    }
  }
}

function validateSourcedClaimRefs(validationBody: Record<string, unknown>, catalog: unknown, errors: string[]): void {
  if (!isRecord(catalog)) return;
  const sourceRefs = catalog.source_refs;
  const evidenceRefs = catalog.evidence_refs;
  const sourceRefIds = new Set<string>();
  const evidenceRefIds = new Set<string>();

  if (Array.isArray(sourceRefs)) {
    for (const item of sourceRefs) {
      if (!isRecord(item)) continue;
      const id = item.source_ref_id;
      if (typeof id === "string" && id.trim().length > 0) sourceRefIds.add(id);
    }
  }
  if (Array.isArray(evidenceRefs)) {
    for (const item of evidenceRefs) {
      if (!isRecord(item)) continue;
      const id = item.evidence_ref_id;
      if (typeof id === "string" && id.trim().length > 0) evidenceRefIds.add(id);
    }
  }
  validateClaimsInValue(validationBody, "validationBody", sourceRefIds, evidenceRefIds, errors);
  validateImplementationRefsInValue(validationBody, "validationBody", catalog, errors);
}

function validateImplementationRefsInValue(
  value: unknown,
  path: string,
  catalog: unknown,
  errors: string[],
): void {
  const implementationRefIds = collectImplementationRefIds(catalog);
  validateImplementationRefsAgainstSet(value, path, implementationRefIds, errors);
}

function collectImplementationRefIds(catalog: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(catalog) || !Array.isArray(catalog.implementation_refs)) return ids;
  for (const item of catalog.implementation_refs) {
    if (!isRecord(item)) continue;
    const id = item.implementation_ref_id;
    if (typeof id === "string" && id.trim().length > 0) ids.add(id);
  }
  return ids;
}

function validateImplementationRefsAgainstSet(
  value: unknown,
  path: string,
  implementationRefIds: Set<string>,
  errors: string[],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateImplementationRefsAgainstSet(item, \`\${path}[\${index}]\`, implementationRefIds, errors);
    }
    return;
  }
  if (!isRecord(value)) return;

  if (Array.isArray(value.implementation_ref_ids)) {
    if (value.implementation_ref_ids.length === 0) {
      errors.push(\`\${path}.implementation_ref_ids must contain at least one implementation_ref_id.\`);
    }
    for (const implementationRefId of value.implementation_ref_ids) {
      if (typeof implementationRefId === "string" && !implementationRefIds.has(implementationRefId)) {
        errors.push(\`\${path}.implementation_ref_ids references unknown implementation_ref_id \${implementationRefId}.\`);
      }
    }
  }

  for (const [fieldName, fieldValue] of Object.entries(value)) {
    validateImplementationRefsAgainstSet(fieldValue, \`\${path}.\${fieldName}\`, implementationRefIds, errors);
  }
}

function validateClaimsInValue(
  value: unknown,
  path: string,
  sourceRefIds: Set<string>,
  evidenceRefIds: Set<string>,
  errors: string[],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateClaimsInValue(item, \`\${path}[\${index}]\`, sourceRefIds, evidenceRefIds, errors);
    }
    return;
  }

  if (!isRecord(value)) return;

  if (typeof value.claim_id === "string" && typeof value.text === "string") {
    const sourceIds = value.source_ref_ids;
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      errors.push(\`\${path}.source_ref_ids must contain at least one source_ref_id.\`);
    } else {
      for (const sourceId of sourceIds) {
        if (typeof sourceId === "string" && !sourceRefIds.has(sourceId)) {
          errors.push(\`\${path}.source_ref_ids references unknown source_ref_id \${sourceId}.\`);
        }
      }
    }

    const evidenceIds = value.evidence_ref_ids;
    if (Array.isArray(evidenceIds)) {
      for (const evidenceId of evidenceIds) {
        if (typeof evidenceId === "string" && !evidenceRefIds.has(evidenceId)) {
          errors.push(\`\${path}.evidence_ref_ids references unknown evidence_ref_id \${evidenceId}.\`);
        }
      }
    }
  }

  for (const [fieldName, fieldValue] of Object.entries(value)) {
    validateClaimsInValue(fieldValue, \`\${path}.\${fieldName}\`, sourceRefIds, evidenceRefIds, errors);
  }
}

function readArrayElementType(type: string): string | undefined {
  return type.endsWith("[]") ? type.slice(0, -2) : undefined;
}

function readLiteralOptions(type: string): Array<string | number | boolean> {
  const parts = type.split("|").map((part) => part.trim());
  const literals = parts.map(readLiteralOption);
  return literals.every((literal) => literal !== undefined)
    ? literals as Array<string | number | boolean>
    : [];
}

function readLiteralOption(type: string): string | number | boolean | undefined {
  if ((type.startsWith('"') && type.endsWith('"')) || (type.startsWith("'") && type.endsWith("'"))) {
    return type.slice(1, -1);
  }
  if (/^-?\\d+(?:\\.\\d+)?$/.test(type)) {
    return Number(type);
  }
  if (type === "true") return true;
  if (type === "false") return false;
  return undefined;
}

function formatOptions(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runCli(): void {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write("Usage: validation <scout-input.json | validation-body.json>\\n");
    process.exitCode = 1;
    return;
  }

  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const subject = isRecord(parsed) && "validationBody" in parsed ? parsed.validationBody : parsed;
  const catalog = readCatalogForSubject(parsed, subject, filePath);
  const errors = validateValidationBody(subject, catalog);
  if (errors.length > 0) {
    process.stderr.write(errors.join("\\n") + "\\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(JSON.stringify({ status: "passed", filePath }, null, 2) + "\\n");
}

function readCatalogForSubject(parsed: unknown, subject: unknown, filePath: string): unknown {
  if (isRecord(parsed) && "validationCatalog" in parsed) return parsed.validationCatalog;
  if (!isRecord(subject) || !isRecord(subject.catalog_ref)) return undefined;
  const uri = subject.catalog_ref.uri;
  if (typeof uri !== "string" || uri.trim().length === 0) return undefined;
  const catalogPath = isAbsolute(uri) ? uri : resolve(dirname(filePath), uri);
  return JSON.parse(readFileSync(catalogPath, "utf8")) as unknown;
}

if (process.argv[1]?.endsWith("validation.generated.js")) {
  runCli();
}
`;
}

function buildBarrelFile(modules: ParsedModule[]): string {
  const lines = [
    generatedHeader(),
    ...modules.map((module) => `export * from "./validation-body/${module.module}.generated.js";`),
    'export * from "./validation-body/validation.generated.js";',
    "",
  ];
  return lines.join("\n");
}

function renderComment(description: string | undefined, indent = ""): string | undefined {
  if (!description) return undefined;
  return `${indent}/** ${description.replace(/\*\//g, "* /")} */`;
}

function generatedHeader(): string {
  return "// Generated by schemas/input/scripts/generate-validation-body.ts from schemas/input/validation-body/*.yaml.\n// Do not edit this file by hand.\n";
}

function parseYamlObject(text: string, file: string): JsonObject {
  const root: JsonObject = {};
  const lines = text.split(/\r?\n/);
  const stack: Array<{ indent: number; value: JsonObject | JsonValue[] }> = [
    { indent: -1, value: root },
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim()) continue;

    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`${file}:${index + 1} list item without list parent.`);
      }
      parent.push(parseScalar(line.slice(2).trim()));
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      throw new Error(`${file}:${index + 1} expected key: value.`);
    }
    if (Array.isArray(parent)) {
      throw new Error(`${file}:${index + 1} mapping item inside scalar list is not supported.`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (rawValue.length > 0) {
      parent[key] = parseScalar(rawValue);
      continue;
    }

    const child: JsonObject | JsonValue[] = nextIndentedLineIsList(lines, index, indent) ? [] : {};
    parent[key] = child;
    stack.push({ indent, value: child });
  }

  return root;
}

function nextIndentedLineIsList(lines: string[], currentIndex: number, currentIndent: number): boolean {
  for (let index = currentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    return indent > currentIndent && line.trim().startsWith("- ");
  }
  return false;
}

function parseScalar(rawValue: string): string | number | boolean {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"'))
    || (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) return Number(rawValue);
  return rawValue;
}

function readObject(value: JsonValue | undefined, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

function readRequiredString(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function readRequiredBoolean(object: JsonObject, key: string, path: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new Error(`${path}.${key} must be a boolean.`);
  }
  return value;
}

function readStringArray(value: JsonValue | undefined, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be a string array.`);
  }
  return value as string[];
}

function normalizeOrder(index: number): number {
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateValidationBodySchema();
}

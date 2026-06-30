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

const SCHEMA_DIR = resolve("schemas/domain/validation");
const OUTPUT_DIR = resolve("src/domain/validation/schema");
const BARREL_PATH = resolve("src/domain/validation/schema/index.ts");
const MODULE_ORDER = [
  "common",
  "research-artifact",
  "verification-report",
  "validation-result",
  "state",
];

export function generateDomainValidationSchema(): void {
  const modules = readSchemaModules();
  const definitions: Record<string, ExportSchema> = {};
  for (const module of modules) {
    for (const [name, declaration] of Object.entries(module.exports)) {
      if (definitions[name]) throw new Error(`Duplicate domain validation declaration: ${name}`);
      definitions[name] = declaration;
    }
  }

  for (const required of ["ResearchArtifact", "VerificationReport", "ValidationResult", "ValidationStateSnapshot"]) {
    if (!definitions[required]) throw new Error(`schemas/domain/validation must declare ${required}.`);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const file of readdirSync(OUTPUT_DIR).filter((entry) => entry.endsWith(".generated.ts"))) {
    rmSync(join(OUTPUT_DIR, file), { force: true });
  }
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

  process.stdout.write(`Generated ${modules.length} domain validation type files and validation.generated.ts\n`);
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
import type { ResearchArtifact } from "./research-artifact.generated.js";
import type { ValidationStateSnapshot } from "./state.generated.js";
import type { ValidationResult } from "./validation-result.generated.js";
import type { VerificationReport } from "./verification-report.generated.js";

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

export const domainValidationRuntimeSchema = ${JSON.stringify(definitions, null, 2)} as const satisfies Readonly<Record<string, DeclarationSchema>>;

const schema: Readonly<Record<string, DeclarationSchema>> = domainValidationRuntimeSchema;

export type DomainValidationArtifact =
  | ResearchArtifact
  | VerificationReport
  | ValidationResult
  | ValidationStateSnapshot;

export function validateDomainValidationArtifact(value: unknown): string[] {
  const type = readArtifactType(value);
  if (!type) return ["domain validation artifact must contain artifact_type."];
  return validateDomainValidationValue(value, type);
}

export function validateDomainValidationValue(value: unknown, type: string): string[] {
  const errors: string[] = [];
  validateType(value, type, type, errors);
  if (errors.length === 0) validateDomainSemanticConstraints(value, type, errors);
  return errors;
}

export function createDomainValidationSkeleton(type: string): unknown {
  return createSkeletonForDeclaration(type);
}

function readArtifactType(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.artifact_type === "string") return value.artifact_type;
  return undefined;
}

function validateDomainSemanticConstraints(value: unknown, type: string, errors: string[]): void {
  if (type === "ResearchArtifact") validateResearchArtifact(value, errors);
  if (type === "VerificationReport") validateVerificationReport(value, errors);
  if (type === "ValidationResult") validateValidationResult(value, errors);
  if (type === "ValidationStateSnapshot") validateValidationStateSnapshot(value, errors);
}

function validateResearchArtifact(value: unknown, errors: string[]): void {
  if (!isRecord(value)) return;
  const status = value.status;
  const bdd = value.bdd_facts;
  if (status === "complete") {
    if (!isRecord(bdd) || !hasNonEmptyArray(bdd.given) || !hasNonEmptyArray(bdd.when) || !hasNonEmptyArray(bdd.then)) {
      errors.push("ResearchArtifact complete requires non-empty bdd_facts.given/when/then.");
    }
    if (!hasNonEmptyArray(value.source_refs)) {
      errors.push("ResearchArtifact complete requires source_refs.");
    }
  }
}

function validateVerificationReport(value: unknown, errors: string[]): void {
  if (!isRecord(value)) return;
  if (value.status === "verified") {
    if (!hasNonEmptyArray(value.evidence_matrix)) {
      errors.push("VerificationReport verified requires evidence_matrix.");
    }
    if (!hasNonEmptyArray(value.evidence_refs)) {
      errors.push("VerificationReport verified requires evidence_refs.");
    }
  }
  const evidenceRefIds = collectStringIds(value.evidence_refs, "evidence_ref_id");
  if (Array.isArray(value.evidence_matrix)) {
    for (const [index, item] of value.evidence_matrix.entries()) {
      if (!isRecord(item)) continue;
      if ((item.verdict === "verified" || item.verdict === "not_verified") && !hasNonEmptyArray(item.evidence_ref_ids)) {
        errors.push(\`VerificationReport.evidence_matrix[\${index}] requires evidence_ref_ids for verdict \${String(item.verdict)}.\`);
      }
      validateIdRefs(item.evidence_ref_ids, evidenceRefIds, \`VerificationReport.evidence_matrix[\${index}].evidence_ref_ids\`, errors);
    }
  }
  if (Array.isArray(value.code_evidence)) {
    for (const [index, item] of value.code_evidence.entries()) {
      if (!isRecord(item)) continue;
      validateIdRefs([item.evidence_ref_id], evidenceRefIds, \`VerificationReport.code_evidence[\${index}].evidence_ref_id\`, errors);
    }
  }
}

function validateValidationResult(value: unknown, errors: string[]): void {
  if (!isRecord(value)) return;
  if (value.gate_status === "accepted" && !hasNonEmptyArray(value.checked_artifact_refs)) {
    errors.push("ValidationResult accepted requires checked_artifact_refs.");
  }
  if (value.gate_status !== "accepted" && !hasNonEmptyArray(value.minimum_fixes)) {
    errors.push("ValidationResult non-accepted gate requires minimum_fixes.");
  }
}

function validateValidationStateSnapshot(value: unknown, errors: string[]): void {
  if (!isRecord(value)) return;
  if (value.current_state === "accepted") {
    if (value.latest_gate_status !== "accepted") {
      errors.push("ValidationStateSnapshot accepted requires latest_gate_status accepted.");
    }
    if (!hasNonEmptyArray(value.artifact_refs) || !hasNonEmptyArray(value.evidence_refs)) {
      errors.push("ValidationStateSnapshot accepted requires artifact_refs and evidence_refs.");
    }
  }
  if ((value.current_state === "blocked" || value.current_state === "failed") && typeof value.blocker !== "string") {
    errors.push("ValidationStateSnapshot blocked/failed requires blocker.");
  }
}

function createSkeletonForDeclaration(name: string): unknown {
  const declaration = schema[name];
  if (!declaration) throw new Error(\`Unknown domain validation declaration: \${name}\`);
  if (declaration.kind === "enum") return declaration.values?.[0] ?? "";

  const result: Record<string, unknown> = {};
  for (const [fieldName, field] of Object.entries(declaration.fields ?? {})) {
    if (field.required) result[fieldName] = createSkeletonForType(field.type);
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

  throw new Error(\`Unsupported domain validation skeleton type: \${type}\`);
}

function validateType(value: unknown, type: string, path: string, errors: string[]): void {
  const arrayElementType = readArrayElementType(type);
  if (arrayElementType) {
    if (!Array.isArray(value)) {
      errors.push(\`\${path} must be an array.\`);
      return;
    }
    for (const [index, item] of value.entries()) validateType(item, arrayElementType, \`\${path}[\${index}]\`, errors);
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
    if (typeof value !== "string" || value.length === 0) errors.push(\`\${path} must be a non-empty string.\`);
    return;
  }
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) errors.push(\`\${path} must be a finite number.\`);
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") errors.push(\`\${path} must be a boolean.\`);
    return;
  }

  const declaration = schema[type];
  if (!declaration) {
    errors.push(\`\${path} uses unknown domain validation schema type \${type}.\`);
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
      if (field.required) errors.push(\`\${fieldPath} is required.\`);
      continue;
    }
    const fieldValue = value[fieldName];
    if (fieldValue === undefined) {
      if (field.required) errors.push(\`\${fieldPath} is required.\`);
      continue;
    }
    validateType(fieldValue, field.type, fieldPath, errors);
  }
}

function collectStringIds(value: unknown, key: string): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = item[key];
    if (typeof id === "string" && id.trim().length > 0) ids.add(id);
  }
  return ids;
}

function validateIdRefs(value: unknown, ids: Set<string>, path: string, errors: string[]): void {
  const refs = Array.isArray(value) ? value : [value];
  for (const ref of refs) {
    if (typeof ref !== "string" || ref.trim().length === 0) continue;
    if (!ids.has(ref)) errors.push(\`\${path} references unknown id \${ref}.\`);
  }
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
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
  if ((type.startsWith('"') && type.endsWith('"')) || (type.startsWith("'") && type.endsWith("'"))) return type.slice(1, -1);
  if (/^-?\\d+(?:\\.\\d+)?$/.test(type)) return Number(type);
  if (type === "true") return true;
  if (type === "false") return false;
  return undefined;
}

function formatOptions(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runCli(): void {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write("Usage: validation.generated.js <domain-validation-artifact.json>\\n");
    process.exitCode = 1;
    return;
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const errors = validateDomainValidationArtifact(parsed);
  if (errors.length > 0) {
    process.stderr.write(errors.join("\\n") + "\\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({ status: "passed", filePath }, null, 2) + "\\n");
}

if (process.argv[1]?.endsWith("validation.generated.js")) runCli();
`;
}

function buildBarrelFile(modules: ParsedModule[]): string {
  return [
    generatedHeader(),
    ...modules.map((module) => `export * from "./${module.module}.generated.js";`),
    'export * from "./validation.generated.js";',
    "",
  ].join("\n");
}

function renderComment(description: string | undefined, indent = ""): string | undefined {
  if (!description) return undefined;
  return `${indent}/** ${description.replace(/\*\//g, "* /")} */`;
}

function generatedHeader(): string {
  return "// Generated by schemas/domain/validation/generate-domain-validation.ts from schemas/domain/validation/*.yaml.\n// Do not edit this file by hand.\n";
}

function parseYamlObject(text: string, file: string): JsonObject {
  const root: JsonObject = {};
  const lines = text.split(/\r?\n/);
  const stack: Array<{ indent: number; value: JsonObject | JsonValue[] }> = [{ indent: -1, value: root }];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim()) continue;

    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();

    const parent = stack[stack.length - 1].value;
    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) throw new Error(`${file}:${index + 1} list item without list parent.`);
      parent.push(parseScalar(line.slice(2).trim()));
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) throw new Error(`${file}:${index + 1} expected key: value.`);
    if (Array.isArray(parent)) throw new Error(`${file}:${index + 1} mapping item inside scalar list is not supported.`);

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
  if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
    return rawValue.slice(1, -1);
  }
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) return Number(rawValue);
  return rawValue;
}

function readObject(value: JsonValue | undefined, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value;
}

function readRequiredString(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path}.${key} must be a non-empty string.`);
  return value;
}

function readOptionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function readRequiredBoolean(object: JsonObject, key: string, path: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new Error(`${path}.${key} must be a boolean.`);
  return value;
}

function readStringArray(value: JsonValue | undefined, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${path} must be a string array.`);
  return value as string[];
}

function normalizeOrder(index: number): number {
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateDomainValidationSchema();
}

import { join, resolve } from "node:path";
import type {
  CodexModelConfig,
  CodexReasoningEffort,
  CodexReasoningSummary,
} from "../../agent-server/codex/model-config.js";
import { readJsonFile, sha256File } from "../../core/fs.js";
import {
  InternalPhase,
  SynthesisPhase,
  type WorkflowPhaseEdges,
} from "../../core/workflow/index.js";
import type {
  WorkflowProfile,
  WorkflowProfileAsset,
  WorkflowResourcePark,
  WorkflowRoleDefinition,
  WorkflowWorkerPhaseDefinition,
} from "../contracts/workflow-profile.js";
import { assertMountPathSegment } from "../files/asset-paths.js";
import { CodexAssetLayout } from "./asset-layout.js";

const reasoningEfforts = new Set<CodexReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const reasoningSummaries = new Set<CodexReasoningSummary>([
  "auto",
  "concise",
  "detailed",
  "none",
]);
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Returns the selected Workflow Profile path under `assets/codex/workflows`. */
export function workflowProfilePath(scoutRoot: string, name: string): string {
  assertMountPathSegment(name, "Workflow Profile name");
  return join(
    resolve(scoutRoot),
    "assets",
    "codex",
    CodexAssetLayout.workflowsRoot,
    `${name}.json`,
  );
}

/** Reads and strictly validates one selected Workflow Profile. */
export function readWorkflowProfile(
  scoutRoot: string,
  name: string,
): WorkflowProfileAsset {
  const path = workflowProfilePath(scoutRoot, name);
  const profile = parseWorkflowProfile(readJsonFile<unknown>(path), path);
  return {
    name,
    sourcePath: `${CodexAssetLayout.workflowsRoot}/${name}.json`,
    hash: sha256File(path),
    profile,
  };
}

function parseWorkflowProfile(value: unknown, path: string): WorkflowProfile {
  const profile = requireRecord(value, path, "Workflow Profile");
  assertKeys(
    profile,
    ["domain", "defaults", "phases", "resources", "roles"],
    path,
    "top-level",
  );
  const defaults = requireRecord(profile.defaults, path, "defaults");
  assertKeys(defaults, ["config", "model", "maxThreads", "maxDepth"], path, "defaults");
  const phases = requireRecord(profile.phases, path, "phases");
  assertKeys(phases, ["workers"], path, "phases");
  const workersValue = requireRecord(phases.workers, path, "phases.workers");
  const workerEntries = Object.entries(workersValue);
  if (workerEntries.length === 0) {
    throw new Error(`Invalid Workflow Profile at ${path}: phases.workers must not be empty.`);
  }
  const workers = Object.fromEntries(workerEntries.map(([name, definition]) => {
    assertMountPathSegment(name, "Worker Phase name");
    if (name === InternalPhase || name === SynthesisPhase) {
      throw new Error(
        `Invalid Workflow Profile at ${path}: phases.workers cannot declare reserved Phase ${name}.`,
      );
    }
    return [name, parseWorkerPhase(definition, path, name)] as const;
  }));
  const resourcesValue = requireRecord(profile.resources, path, "resources");
  const resourceEntries = Object.entries(resourcesValue);
  if (resourceEntries.length === 0) {
    throw new Error(`Invalid Workflow Profile at ${path}: resources must not be empty.`);
  }
  const resources = Object.fromEntries(resourceEntries.map(([name, definition]) => {
    assertMountPathSegment(name, "Resource Park name");
    return [name, parseResourcePark(definition, path, name, workers)] as const;
  }));
  const defaultResourceParks = Object.entries(resources)
    .filter(([, resource]) => resource.default === true)
    .map(([name]) => name);
  if (defaultResourceParks.length > 1) {
    throw new Error(
      `Invalid Workflow Profile at ${path}: resources must declare at most one`
      + ` global default Resource Park; found ${defaultResourceParks.length}.`,
    );
  }
  const rolesValue = requireRecord(profile.roles, path, "roles");
  if (!Object.hasOwn(rolesValue, "coordinator")) {
    throw new Error(`Invalid Workflow Profile at ${path}: roles.coordinator is required.`);
  }
  const roles = Object.fromEntries(Object.entries(rolesValue).map(([name, definition]) => {
    assertMountPathSegment(name, "Workflow role name");
    return [name, parseRole(definition, path, name, workers)] as const;
  }));
  if (roles.coordinator.phases !== undefined) {
    throw new Error(
      `Invalid Workflow Profile at ${path}: roles.coordinator cannot declare phases.`,
    );
  }
  validateEdges(workers, path);
  return {
    domain: requireDomainId(profile.domain, path),
    defaults: {
      config: requireString(defaults.config, path, "defaults.config"),
      model: parseModel(defaults.model, path, "defaults.model"),
      maxThreads: requireInteger(defaults.maxThreads, path, "defaults.maxThreads", 1),
      maxDepth: requireInteger(defaults.maxDepth, path, "defaults.maxDepth", 0),
    },
    phases: {
      workers,
    },
    resources,
    roles,
  };
}

function requireDomainId(value: unknown, path: string): string {
  const domain = requireString(value, path, "domain");
  if (!DOMAIN_ID_PATTERN.test(domain)) {
    throw new Error(`Invalid Workflow Profile at ${path}: domain has invalid token: ${domain}`);
  }
  return domain;
}

function parseWorkerPhase(
  value: unknown,
  path: string,
  name: string,
): WorkflowWorkerPhaseDefinition {
  const label = `phases.workers.${name}`;
  const phase = requireRecord(value, path, label);
  assertKeys(phase, ["edges"], path, label);
  const edgesValue = requireRecord(phase.edges, path, `${label}.edges`);
  assertKeys(edgesValue, ["completed", "error"], path, `${label}.edges`);
  const edges: WorkflowPhaseEdges = {
    completed: requireNullableString(edgesValue.completed, path, `${label}.edges.completed`),
    error: requireNullableString(edgesValue.error, path, `${label}.edges.error`),
  };
  return {
    edges,
  };
}

function parseResourcePark(
  value: unknown,
  path: string,
  name: string,
  workers: Readonly<Record<string, WorkflowWorkerPhaseDefinition>>,
): WorkflowResourcePark {
  const label = `resources.${name}`;
  const resource = requireRecord(value, path, label);
  assertKeys(resource, [
    "default",
    "phases",
    "shellTools",
    "mcpServers",
    "plugins",
    "readableRoots",
    "writableRoots",
  ], path, label);
  if (resource.default !== undefined && resource.default !== true) {
    throw new Error(
      `Invalid Workflow Profile at ${path}: ${label}.default must be true when declared.`,
    );
  }
  const phases = requireStringArray(resource.phases, path, `${label}.phases`);
  if (resource.default !== true && phases.length === 0) {
    throw new Error(`Invalid Workflow Profile at ${path}: ${label}.phases must not be empty.`);
  }
  for (const phase of phases) {
    if (phase !== SynthesisPhase && !Object.hasOwn(workers, phase)) {
      throw new Error(
        `Invalid Workflow Profile at ${path}: ${label}`
        + ` references unknown Phase ${phase}.`,
      );
    }
  }
  const shellTools = requireStringArray(resource.shellTools, path, `${label}.shellTools`);
  const mcpServers = requireStringArray(resource.mcpServers, path, `${label}.mcpServers`);
  const plugins = requireStringArray(resource.plugins, path, `${label}.plugins`);
  for (const resourceName of [...shellTools, ...mcpServers, ...plugins]) {
    assertMountPathSegment(resourceName, `${label} resource name`);
  }
  return {
    ...(resource.default === true ? { default: true as const } : {}),
    phases,
    shellTools,
    mcpServers,
    plugins,
    readableRoots: requireStringArray(resource.readableRoots, path, `${label}.readableRoots`),
    writableRoots: requireStringArray(resource.writableRoots, path, `${label}.writableRoots`),
  };
}

function parseRole(
  value: unknown,
  path: string,
  name: string,
  workers: Readonly<Record<string, WorkflowWorkerPhaseDefinition>>,
): WorkflowRoleDefinition {
  const label = `roles.${name}`;
  const role = requireRecord(value, path, label);
  assertKeys(role, ["phases", "multiAgent", "customAgents", "model"], path, label);
  const phases = role.phases === undefined
    ? undefined
    : requireStringArray(role.phases, path, `${label}.phases`);
  if (name !== "coordinator" && (!phases || phases.length === 0)) {
    throw new Error(`Invalid Workflow Profile at ${path}: ${label}.phases must not be empty.`);
  }
  for (const phase of phases ?? []) {
    if (!Object.hasOwn(workers, phase)) {
      throw new Error(
        `Invalid Workflow Profile at ${path}: ${label} references unknown Worker Phase ${phase}.`,
      );
    }
  }
  const customAgents = requireStringArray(role.customAgents, path, `${label}.customAgents`);
  for (const customAgent of customAgents) {
    assertMountPathSegment(customAgent, `${label}.customAgents item`);
  }
  return {
    phases,
    multiAgent: requireBoolean(role.multiAgent, path, `${label}.multiAgent`),
    customAgents,
    model: role.model === undefined ? undefined : parseModel(role.model, path, `${label}.model`),
  };
}

function validateEdges(
  workers: Readonly<Record<string, WorkflowWorkerPhaseDefinition>>,
  path: string,
): void {
  for (const [name, phase] of Object.entries(workers)) {
    for (const [outcome, target] of Object.entries(phase.edges)) {
      if (target !== null && !Object.hasOwn(workers, target)) {
        throw new Error(
          `Invalid Workflow Profile at ${path}: phases.workers.${name}.edges.${outcome}`
          + ` references unknown Worker Phase ${target}.`,
        );
      }
    }
  }
}

function parseModel(value: unknown, path: string, label: string): CodexModelConfig {
  const model = requireRecord(value, path, label);
  assertKeys(model, ["id", "provider", "reasoningEffort", "reasoningSummary"], path, label);
  const provider = requireString(model.provider, path, `${label}.provider`);
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) {
    throw new Error(`Invalid Workflow Profile at ${path}: invalid ${label}.provider.`);
  }
  const reasoningEffort = requireString(
    model.reasoningEffort,
    path,
    `${label}.reasoningEffort`,
  ) as CodexReasoningEffort;
  const reasoningSummary = requireString(
    model.reasoningSummary,
    path,
    `${label}.reasoningSummary`,
  ) as CodexReasoningSummary;
  if (!reasoningEfforts.has(reasoningEffort)) {
    throw new Error(`Invalid Workflow Profile at ${path}: unsupported ${label}.reasoningEffort.`);
  }
  if (!reasoningSummaries.has(reasoningSummary)) {
    throw new Error(`Invalid Workflow Profile at ${path}: unsupported ${label}.reasoningSummary.`);
  }
  return {
    id: requireString(model.id, path, `${label}.id`),
    provider,
    reasoningEffort,
    reasoningSummary,
  };
}

function requireRecord(value: unknown, path: string, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Workflow Profile at ${path}: ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid Workflow Profile at ${path}: ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireNullableString(value: unknown, path: string, label: string): string | null {
  if (value === null) return null;
  return requireString(value, path, label);
}

function requireStringArray(value: unknown, path: string, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Workflow Profile at ${path}: ${label} must be an array.`);
  }
  const result = value.map((entry) => requireString(entry, path, `${label} item`));
  if (new Set(result).size !== result.length) {
    throw new Error(`Invalid Workflow Profile at ${path}: ${label} contains duplicates.`);
  }
  return result;
}

function requireBoolean(value: unknown, path: string, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid Workflow Profile at ${path}: ${label} must be a boolean.`);
  }
  return value;
}

function requireInteger(
  value: unknown,
  path: string,
  label: string,
  minimum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(
      `Invalid Workflow Profile at ${path}: ${label} must be an integer >= ${minimum}.`,
    );
  }
  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid Workflow Profile at ${path}: unknown ${label} field(s): ${unknown.join(", ")}.`,
    );
  }
}

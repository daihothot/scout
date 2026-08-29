import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  hashDirectory,
  readJsonFile,
  sha256File,
  sha256Text,
} from "../../core/fs.js";
import type { MaterializeOptions } from "../contracts/materialization.js";
import type { MountContext } from "../contracts/mount-context.js";
import type { AgentProfile } from "../contracts/profile.js";
import type {
  McpServersFile,
  ShellToolContract,
} from "../contracts/resources.js";
import { CodexAssetLayout } from "../assets/asset-layout.js";
import {
  assertAssetFileExists,
  assertMountPathSegment,
  customAgentNameFromPath,
  resolveRequiredAssetFile,
  skillNameFromPath,
} from "../files/asset-paths.js";
import {
  buildMountMacroValues,
  resolveMountMacros,
} from "../mount/macros.js";
import { profileResourceHash } from "../assets/agent-profile.js";
import {
  buildScoutSkillCatalog,
  listScoutSkillPaths,
  resolveScoutSkillsForPhases,
} from "../assets/skill-catalog.js";
import { readWorkflowProfile } from "../assets/workflow-profiles.js";
import type { WorkflowProfileAsset } from "../contracts/workflow-profile.js";
import { WorkflowBuilder } from "./workflow-builder.js";
import { SynthesisPhase } from "../../core/workflow/index.js";

/**
 * Derives the immutable per-role runtime description from the Scout checkout.
 * This pass reads assets and profile data but does not touch the mount root.
 */
export class MountContextBuilder {
  constructor(private readonly options: MaterializeOptions) {}

  build(): MountContext {
    const options = this.options;
    const scoutRoot = resolve(options.scoutRoot);
    const assetsRoot = join(scoutRoot, "assets", "codex");
    const runId = normalizeRunId(options.runId);
    const runRoot = join(scoutRoot, "run", runId);
    const agentId = sanitizeAgentId(options.agentId);
    const workflowProfileName = options.workflowProfileName ?? (() => {
      const workflowRoot = join(assetsRoot, CodexAssetLayout.workflowsRoot);
      const names = readdirSync(workflowRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .sort();
      if (names.length !== 1 || !names[0]) {
        throw new Error(
          "MaterializeOptions.workflowProfileName is required unless exactly one Workflow Profile exists.",
        );
      }
      return names[0];
    })();
    const workflowProfileAsset = readWorkflowProfile(scoutRoot, workflowProfileName);
    const agentRoot = join(runRoot, "agents", agentId);
    const artifactRoot = join(agentRoot, "artifacts");
    const logsRoot = join(agentRoot, "logs");
    const tempRoot = join(agentRoot, "tmp");
    const mountRoot = join(agentRoot, "mount");
    const agentProfile = new WorkflowBuilder(workflowProfileAsset).buildAgentProfile(agentId);
    const mcpServers = readJsonFile<McpServersFile>(join(assetsRoot, CodexAssetLayout.mcpServers));
    const shellTools = readJsonFile<{ tools: ShellToolContract[] }>(
      join(assetsRoot, CodexAssetLayout.shellTools),
    );
    assertAssetFileExists(assetsRoot, agentProfile.config, `config for agent ${agentId}`);
    const profiledMcpServers = filterMcpServers(mcpServers, agentProfile.mcpServers);
    const profiledShellTools = filterShellTools(shellTools.tools, agentProfile.shellTools ?? []);
    const profiledCustomAgentPaths = filterCustomAgents(
      listCustomAgentPaths(assetsRoot),
      agentProfile.customAgents,
    );
    const skillPaths = listScoutSkillPaths(assetsRoot);
    const fullSkillCatalog = buildScoutSkillCatalog({ assetsRoot, skillPaths });
    const skillCatalog = resolveScoutSkillsForPhases(fullSkillCatalog, agentProfile.phases);
    const profiledSkillPaths = filterSkills(
      skillPaths,
      skillCatalog.map((skill) => skill.name),
    );
    const profiledPluginPaths = filterPlugins(listPluginPaths(assetsRoot), agentProfile.plugins);
    const computedResourceHash = computeResourceHash({
      assetsRoot,
      agentId,
      agentProfile,
      mcpServers: profiledMcpServers,
      shellTools: profiledShellTools,
      customAgentPaths: profiledCustomAgentPaths,
      skillPaths: profiledSkillPaths,
      pluginPaths: profiledPluginPaths,
    });
    const assetCommitHash = sha256Text([
      `agent:${agentId}`,
      `agentProfile:${JSON.stringify(agentProfile)}`,
      `resource:${computedResourceHash}`,
      `run:${runId}`,
    ].join("\n"));
    const mountHash = sha256Text(`assetCommit:${assetCommitHash}`);
    const assetCommitId = options.persistedIdentity?.assetCommitId
      ?? `ac_${assetCommitHash.slice(0, 16)}`;
    const parentAssetCommitId = options.persistedIdentity
      ? options.persistedIdentity.parentAssetCommitId
      : options.parentAssetCommitId;
    const mountId = options.persistedIdentity?.mountId ?? `m_${mountHash.slice(0, 16)}`;
    const readableRoots = resolveAgentProfileRoots({
      roots: agentProfile.readableRoots,
      scoutRoot,
      runRoot,
      mountRoot,
      artifactRoot,
      tempRoot,
    });
    const writableRoots = resolveAgentProfileRoots({
      roots: agentProfile.writableRoots,
      scoutRoot,
      runRoot,
      mountRoot,
      artifactRoot,
      tempRoot,
    });
    return {
      scoutRoot,
      assetsRoot,
      runId,
      runRoot,
      agentId,
      agentRoot,
      artifactRoot,
      logsRoot,
      tempRoot,
      mountRoot,
      agentProfile,
      profiledMcpServers,
      profiledShellTools,
      profiledCustomAgentPaths,
      profiledSkillPaths,
      profiledPluginPaths,
      skillCatalog,
      workflowProfileAsset,
      resourceHash: computedResourceHash,
      assetCommitId,
      parentAssetCommitId,
      mountId,
      readableRoots,
      writableRoots,
    };
  }
}

function normalizeRunId(runId: string | undefined): string {
  const value = runId?.trim()
    || `run-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  assertMountPathSegment(value, "runId");
  return value;
}

function sanitizeAgentId(agentId: string): string {
  const normalized = agentId.trim();
  assertMountPathSegment(normalized, "agentId");
  return normalized;
}

function filterMcpServers(mcpServers: McpServersFile, names: string[]): McpServersFile {
  assertUnique(names, "mcpServers");
  const servers = Object.fromEntries(names.map((name) => {
    assertMountPathSegment(name, "MCP server name");
    const server = mcpServers.servers[name];
    if (!server) throw new Error(`Agent profile references unknown MCP server: ${name}`);
    return [name, server] as const;
  }));
  return { servers };
}

function filterShellTools(tools: ShellToolContract[], ids: string[]): ShellToolContract[] {
  assertUnique(ids, "shellTools");
  const byId = new Map(tools.map((tool) => [tool.id, tool] as const));
  const selected = ids.map((id) => {
    const tool = byId.get(id);
    if (!tool) throw new Error(`Agent profile references unknown shell tool: ${id}`);
    assertMountPathSegment(tool.exposeAs, `shell tool exposeAs for ${tool.id}`);
    if ("smokeArgs" in tool || "marker" in tool) {
      throw new Error(`Removed shell tool smoke fields are not accepted for ${tool.id}.`);
    }
    const smoke: unknown = tool.smoke;
    if (smoke !== undefined) {
      if (smoke === null || typeof smoke !== "object" || Array.isArray(smoke)) {
        throw new Error(`Invalid shell tool smoke contract for ${tool.id}.`);
      }
      if (!("scope" in smoke)) {
        throw new Error(`Missing shell tool smoke scope for ${tool.id}.`);
      }
      if (smoke.scope !== "mount" && smoke.scope !== "run") {
        throw new Error(`Invalid shell tool smoke scope for ${tool.id}: ${String(smoke.scope)}`);
      }
      if (!("args" in smoke) || !Array.isArray(smoke.args)) {
        throw new Error(`Missing or invalid shell tool smoke args for ${tool.id}.`);
      }
      if (smoke.args.some((argument) => typeof argument !== "string")) {
        throw new Error(`Invalid shell tool smoke args for ${tool.id}.`);
      }
      if ("marker" in smoke && smoke.marker !== undefined
        && (typeof smoke.marker !== "string" || smoke.marker.length === 0)) {
        throw new Error(`Invalid shell tool smoke marker for ${tool.id}.`);
      }
      if ("managedCodebase" in smoke && smoke.managedCodebase !== undefined
        && (typeof smoke.managedCodebase !== "string" || smoke.managedCodebase.length === 0)) {
        throw new Error(`Invalid shell tool smoke managed codebase for ${tool.id}.`);
      }
    }
    return tool;
  });
  const toolByExecutableName = new Map<string, ShellToolContract>();
  for (const tool of selected) {
    const existing = toolByExecutableName.get(tool.exposeAs);
    if (existing) {
      throw new Error(
        `Agent profile shell tools expose the same executable name: ${tool.exposeAs}`
        + ` (${existing.id}, ${tool.id})`,
      );
    }
    toolByExecutableName.set(tool.exposeAs, tool);
  }
  return selected;
}

function filterCustomAgents(customAgentPaths: string[], names: string[]): string[] {
  assertUnique(names, "customAgents");
  const byName = new Map(customAgentPaths.map((path) => [customAgentNameFromPath(path), path] as const));
  return names.map((name) => {
    const path = byName.get(name);
    if (!path) throw new Error(`Agent profile references unknown custom agent: ${name}`);
    return path;
  });
}

function filterSkills(skillPaths: string[], names: string[]): string[] {
  assertUnique(names, "skills");
  const byName = new Map(skillPaths.map((path) => [skillNameFromPath(path), path] as const));
  return names.map((name) => {
    const path = byName.get(name);
    if (!path) throw new Error(`Agent profile references unknown skill: ${name}`);
    return path;
  });
}

function filterPlugins(pluginPaths: string[], names: string[]): string[] {
  assertUnique(names, "plugins");
  const byName = new Map(pluginPaths.map((path) => [basename(path), path] as const));
  return names.map((name) => {
    const path = byName.get(name);
    if (!path) throw new Error(`Agent profile references unknown plugin: ${name}`);
    return path;
  });
}

function listCustomAgentPaths(assetsRoot: string): string[] {
  const customAgentsRoot = join(assetsRoot, CodexAssetLayout.customAgentsRoot);
  if (!existsSync(customAgentsRoot)) return [];
  return readdirSync(customAgentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => join(CodexAssetLayout.customAgentsRoot, entry.name))
    .sort();
}

function listPluginPaths(assetsRoot: string): string[] {
  const pluginsRoot = join(assetsRoot, CodexAssetLayout.pluginsRoot);
  if (!existsSync(pluginsRoot)) return [];
  return listPluginDirectories(pluginsRoot)
    .map((path) => relative(assetsRoot, path))
    .sort();
}

function listPluginDirectories(root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(root, entry.name);
    if (existsSync(join(child, ".codex-plugin", "plugin.json"))) {
      results.push(child);
      continue;
    }
    results.push(...listPluginDirectories(child));
  }
  return results;
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Agent profile ${label} contains duplicate entry: ${value}`);
    seen.add(value);
  }
}

function resolveAgentProfileRoots(input: {
  roots?: string[];
  scoutRoot: string;
  runRoot: string;
  mountRoot: string;
  artifactRoot: string;
  tempRoot: string;
}): string[] {
  const dynamicValues = buildMountMacroValues({
    scoutRoot: input.scoutRoot,
    runRoot: input.runRoot,
    mountRoot: input.mountRoot,
    artifactRoot: input.artifactRoot,
    tempRoot: input.tempRoot,
    assetCommitId: "",
  });
  return uniqueStrings((input.roots ?? [])
    .map((root) => resolveMountMacros(root, dynamicValues))
    .filter((root) => root.length > 0)
    .map((root) => resolveProfileRoot(root, input.scoutRoot)));
}

function resolveProfileRoot(root: string, scoutRoot: string): string {
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return resolve(homedir(), root.slice(2));
  if (isAbsolute(root)) return root;
  return resolve(scoutRoot, root);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Computes the portable identity of the selected resource inventory. Device
 * executable paths are resolved separately and are therefore not included as
 * authoritative asset identity.
 */
export function computeResourceHash(input: {
  assetsRoot: string;
  agentId: string;
  agentProfile: AgentProfile;
  mcpServers: McpServersFile;
  shellTools: ShellToolContract[];
  customAgentPaths: string[];
  skillPaths: string[];
  pluginPaths: string[];
}): string {
  const isSynthesisRole = input.agentProfile.phases.includes(SynthesisPhase);
  const parts = [
    `agent:${input.agentId}`,
    `agentProfile:${profileResourceHash(input.agentProfile)}`,
    `agents:${sha256File(join(input.assetsRoot, CodexAssetLayout.agentsMd))}`,
    ...(isSynthesisRole
      ? []
      : [`workerAgents:${sha256File(join(input.assetsRoot, CodexAssetLayout.workerAgentsMd))}`]),
    `config:${input.agentProfile.config}:${sha256File(join(input.assetsRoot, input.agentProfile.config))}`,
    `mcpServers:${sha256File(join(input.assetsRoot, CodexAssetLayout.mcpServers))}`,
    ...computeMcpServerResourceHashParts(input.assetsRoot, input.mcpServers),
    ...computeShellToolResourceHashParts(input.assetsRoot, input.shellTools),
    ...input.customAgentPaths.map((path) => `customAgent:${path}:${sha256File(join(input.assetsRoot, path))}`),
    ...hashVendorDirectories(input.assetsRoot),
    ...input.skillPaths.map((skill) =>
      `skill:${skill}:${hashDirectory(dirname(join(input.assetsRoot, skill)))}`
    ),
    ...input.pluginPaths.map((plugin) => `plugin:${plugin}:${hashDirectory(join(input.assetsRoot, plugin))}`),
  ];
  return sha256Text(parts.sort().join("\n"));
}

function hashVendorDirectories(assetsRoot: string): string[] {
  const vendorsRoot = join(assetsRoot, CodexAssetLayout.vendorsRoot);
  if (!existsSync(vendorsRoot)) return [];
  return readdirSync(vendorsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(CodexAssetLayout.vendorsRoot, entry.name))
    .map((vendor) => `vendor:${vendor}:${hashDirectory(join(assetsRoot, vendor))}`);
}

function computeMcpServerResourceHashParts(assetsRoot: string, mcpServers: McpServersFile): string[] {
  const parts: string[] = [];
  for (const [name, server] of Object.entries(mcpServers.servers)) {
    const appendResource = (kind: "command" | "arg", assetPath: string) => {
      if (!assetPath.startsWith("assets/")) return;
      const path = resolveRequiredAssetFile(assetPath, assetsRoot);
      parts.push(`mcpServer${kind === "command" ? "Command" : ""}:${name}:${assetPath}:${sha256File(path)}`);
      const vendorRoot = join(dirname(path), "vendor");
      if (existsSync(vendorRoot)) {
        parts.push(`mcpServerVendor:${name}:${relative(assetsRoot, vendorRoot)}:${hashDirectory(vendorRoot)}`);
      }
    };
    appendResource("command", server.command);
    for (const arg of server.args ?? []) appendResource("arg", arg);
  }
  return parts;
}

function computeShellToolResourceHashParts(assetsRoot: string, shellTools: ShellToolContract[]): string[] {
  return shellTools.flatMap((tool) => [
    ...hashOptionalAssetFile(`shellToolCommand:${tool.id}`, tool.command, assetsRoot),
    ...(tool.args ?? []).flatMap((arg) => hashOptionalAssetFile(`shellToolArg:${tool.id}`, arg, assetsRoot)),
  ]);
}

function hashOptionalAssetFile(prefix: string, assetPath: string, assetsRoot: string): string[] {
  if (!assetPath.startsWith("assets/")) return [];
  const resolvedPath = resolveRequiredAssetFile(assetPath, assetsRoot);
  return [`${prefix}:${assetPath}:${sha256File(resolvedPath)}`];
}

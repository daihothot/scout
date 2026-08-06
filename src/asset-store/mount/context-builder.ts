import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  hashDirectory,
  readJsonFile,
  sha256File,
  sha256Text,
} from "../../core/fs.js";
import { isPathWithin } from "../../core/path.js";
import type {
  AgentProfile,
  MountManifest,
  MountMaterializationStep,
  McpServersFile,
  ShellToolContract,
  MountPreparationDecision,
} from "../types.js";
import { CodexAssetLayout, roleAgentPath } from "../assets/asset-layout.js";
import {
  assertMountPathSegment,
  resolveAssetArg,
  resolveAssetLocalPath,
} from "./helpers.js";
import {
  buildMountMacroValues,
  resolveMountMacros,
} from "./macros.js";
import {
  readAgentProfilesForRepo,
  resolveAgentProfile,
} from "../assets/agent-profiles.js";
import { buildScoutSkillCatalog } from "../assets/skill-catalog.js";

export interface MaterializeOptions {
  repoRoot: string;
  runId?: string;
  agentId: string;
  persistedManifest?: MountManifest;
  parentAssetCommitId?: string;
  persistedIdentity?: {
    assetCommitId: string;
    parentAssetCommitId: string | undefined;
    mountId: string;
    resourceHash: string;
    allowLegacyResourceIdentityMigration?: boolean;
  };
  cleanRunRoot?: boolean;
  onPreparationDecision?(decision: MountPreparationDecision, reason?: string): void;
  onMaterializationStep?(step: MountMaterializationStep): void;
}

export interface MountContext {
  repoRoot: string;
  assetsRoot: string;
  runId: string;
  runRoot: string;
  agentId: string;
  agentRoot: string;
  artifactRoot: string;
  logsRoot: string;
  mountRoot: string;
  agentProfile: AgentProfile;
  profiledMcpServers: McpServersFile;
  profiledShellTools: ShellToolContract[];
  profiledCustomAgentPaths: string[];
  profiledSkillPaths: string[];
  profiledPluginPaths: string[];
  skillCatalog: ReturnType<typeof buildScoutSkillCatalog>;
  resourceHash: string;
  assetCommitId: string;
  parentAssetCommitId?: string;
  mountId: string;
  trustedRoots: string[];
  writableRoots: string[];
}

/**
 * Derives the immutable per-role runtime description from the Scout checkout.
 * This pass reads assets and profile data but does not touch the mount root.
 */
export class MountContextBuilder {
  constructor(private readonly options: MaterializeOptions) {}

  build(): MountContext {
    const options = this.options;
    const repoRoot = resolve(options.repoRoot);
    const assetsRoot = join(repoRoot, "assets", "codex");
    const runId = normalizeRunId(options.runId);
    const runRoot = join(repoRoot, "run", runId);
    const agentId = sanitizeAgentId(options.agentId);
    const agentRoot = join(runRoot, "agents", agentId);
    const artifactRoot = join(agentRoot, "artifacts");
    const logsRoot = join(agentRoot, "logs");
    const mountRoot = join(agentRoot, "mount");
    const agentProfile = resolveAgentProfile(readAgentProfilesForRepo(repoRoot), agentId);
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
    const profiledSkillPaths = filterSkills(listSkillPaths(assetsRoot), agentProfile.skills);
    const profiledPluginPaths = filterPlugins(listPluginPaths(assetsRoot), agentProfile.plugins);
    const skillCatalog = buildScoutSkillCatalog({ assetsRoot, skillPaths: profiledSkillPaths });
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
    const trustedRoots = resolveAgentProfileRoots({
      roots: agentProfile.trustedRoots,
      repoRoot,
      runRoot,
      mountRoot,
      artifactRoot,
    });
    const writableRoots = resolveAgentProfileRoots({
      roots: agentProfile.writableRoots,
      repoRoot,
      runRoot,
      mountRoot,
      artifactRoot,
    });
    return {
      repoRoot,
      assetsRoot,
      runId,
      runRoot,
      agentId,
      agentRoot,
      artifactRoot,
      logsRoot,
      mountRoot,
      agentProfile,
      profiledMcpServers,
      profiledShellTools,
      profiledCustomAgentPaths,
      profiledSkillPaths,
      profiledPluginPaths,
      skillCatalog,
      resourceHash: computedResourceHash,
      assetCommitId,
      parentAssetCommitId,
      mountId,
      trustedRoots,
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

export function assertAssetFileExists(assetsRoot: string, assetPath: string, label: string): void {
  if (!existsSync(resolveAssetRelativePath(assetPath, assetsRoot))) {
    throw new Error(`Agent profile references missing ${label}: ${assetPath}`);
  }
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
  return ids.map((id) => {
    const tool = byId.get(id);
    if (!tool) throw new Error(`Agent profile references unknown shell tool: ${id}`);
    assertMountPathSegment(tool.exposeAs, `shell tool exposeAs for ${tool.id}`);
    return tool;
  });
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

function listSkillPaths(assetsRoot: string): string[] {
  const skillsRoot = join(assetsRoot, CodexAssetLayout.skillsRoot);
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(CodexAssetLayout.skillsRoot, entry.name, "SKILL.md"))
    .filter((path) => existsSync(join(assetsRoot, path)))
    .sort();
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
  repoRoot: string;
  runRoot: string;
  mountRoot: string;
  artifactRoot: string;
}): string[] {
  const dynamicValues = buildMountMacroValues({
    repoRoot: input.repoRoot,
    runRoot: input.runRoot,
    mountRoot: input.mountRoot,
    artifactRoot: input.artifactRoot,
    assetCommitId: "",
  });
  return uniqueStrings((input.roots ?? [])
    .map((root) => resolveMountMacros(root, dynamicValues))
    .filter((root) => root.length > 0)
    .map((root) => resolveProfileRoot(root, input.repoRoot)));
}

function resolveProfileRoot(root: string, repoRoot: string): string {
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return resolve(homedir(), root.slice(2));
  if (isAbsolute(root)) return root;
  return resolve(repoRoot, root);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

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
  const parts = [
    `agent:${input.agentId}`,
    `agentProfile:${JSON.stringify(input.agentProfile)}`,
    `agents:${sha256File(join(input.assetsRoot, CodexAssetLayout.agentsMd))}`,
    `agentProfiles:${sha256File(join(input.assetsRoot, CodexAssetLayout.agentProfiles))}`,
    `config:${input.agentProfile.config}:${sha256File(join(input.assetsRoot, input.agentProfile.config))}`,
    `mcpServers:${sha256File(join(input.assetsRoot, CodexAssetLayout.mcpServers))}`,
    ...computeMcpServerResourceHashParts(input.assetsRoot, input.mcpServers),
    ...computeShellToolResourceHashParts(input.assetsRoot, input.shellTools),
    ...input.customAgentPaths.map((path) => `customAgent:${path}:${sha256File(join(input.assetsRoot, path))}`),
    ...hashVendorDirectories(input.assetsRoot),
    ...(input.agentId === "coordinator"
      ? []
      : [`workerAgent:${CodexAssetLayout.workerAgent}:${sha256File(join(input.assetsRoot, CodexAssetLayout.workerAgent))}`]),
    `roleAgent:${input.agentId}:${roleAgentPath(input.agentId)}:${sha256File(join(input.assetsRoot, roleAgentPath(input.agentId)))}`,
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

export function resolveRequiredAssetFile(assetPath: string, assetsRoot: string): string {
  const resolvedPath = resolveAssetArg(assetPath, assetsRoot);
  if (!existsSync(resolvedPath)) throw new Error(`Asset-local resource is missing: ${assetPath}`);
  return resolvedPath;
}

export function customAgentNameFromPath(customAgentPath: string): string {
  return basename(customAgentPath, ".toml");
}

export function skillNameFromPath(skillPath: string): string {
  const source = resolve(skillPath);
  return basename(source) === "SKILL.md" ? basename(resolve(source, "..")) : basename(source);
}

export function resolveAssetRelativePath(assetPath: string, assetsRoot: string): string {
  const resolvedPath = resolve(assetsRoot, assetPath);
  if (!isPathWithin(assetsRoot, resolvedPath)) {
    throw new Error(`Asset path escapes assets root: ${assetPath}`);
  }
  return resolvedPath;
}

export function assetSourcePath(assetPath: string): string {
  return join("assets", "codex", assetPath);
}

export function relativeOrSelf(base: string, target: string): string {
  const relativePath = relative(base, target);
  return relativePath.length === 0 ? "." : relativePath;
}

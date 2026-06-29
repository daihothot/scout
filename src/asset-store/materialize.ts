import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ensureDir,
  hashDirectory,
  recreateDir,
  readJsonFile,
  safeSymlink,
  sha256File,
  sha256Text,
  writeJsonFile,
  writeTextFile,
} from "../core/fs.js";
import type {
  AgentProfile,
  AgentProfilesFile,
  CodexMount,
  MaterializedMcpServer,
  MountManifest,
  MountMaterializationIssue,
  McpServersFile,
  ShellToolContract,
  ShellToolsFile,
} from "./types.js";
import { CodexAssetLayout, roleAgentPath } from "./asset-layout.js";
import {
  buildMountDynamicValues,
  generateCodexConfig,
  materializeMcpServers,
  materializeShellTools,
  writePluginMarketplace,
} from "./mount-helpers.js";
import {
  buildMountMacroValues,
  resolveMountMacros,
} from "./mount-macros.js";

export interface MaterializeOptions {
  repoRoot: string;
  runId?: string;
  agentId: string;
  parentAssetCommitId?: string;
  cleanRunRoot?: boolean;
  mcpServerBindings?: Record<string, Record<string, string>>;
}

export function materializeCodexMount(options: MaterializeOptions): CodexMount {
  const repoRoot = resolve(options.repoRoot);
  const mcpServerBindings = normalizeMcpServerBindings(options.mcpServerBindings ?? {});
  const assetsRoot = join(repoRoot, "assets", "codex");
  const runId = options.runId ?? `run-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  const runRoot = join(repoRoot, "run", runId);
  const agentId = sanitizeAgentId(options.agentId);
  const agentRoot = join(runRoot, "agents", agentId);
  const artifactRoot = join(agentRoot, "artifacts");
  const logsRoot = join(agentRoot, "logs");
  const agentProfile = readAgentProfile(assetsRoot, agentId);
  const mountRoot = join(agentRoot, "mount");

  if (options.cleanRunRoot ?? true) {
    ensureDir(runRoot);
    ensureDir(join(runRoot, "agents"));
    recreateDir(agentRoot);
  } else {
    ensureDir(runRoot);
    ensureDir(join(runRoot, "agents"));
    ensureDir(agentRoot);
  }
  recreateDir(mountRoot);
  ensureDir(artifactRoot);
  ensureDir(logsRoot);
  ensureDir(join(mountRoot, ".codex"));
  ensureDir(join(mountRoot, ".agents", "skills"));
  ensureDir(join(mountRoot, ".agents", "plugins"));
  ensureDir(join(mountRoot, "agents"));
  ensureDir(join(mountRoot, "plugins"));
  ensureDir(join(mountRoot, "bin"));
  ensureDir(join(mountRoot, "mcp"));

  const mcpServers = readJsonFile<McpServersFile>(join(assetsRoot, CodexAssetLayout.mcpServers));
  const shellTools = readJsonFile<ShellToolsFile>(join(assetsRoot, CodexAssetLayout.shellTools));
  assertAssetFileExists(assetsRoot, agentProfile.config, `config for agent ${agentId}`);
  const profiledMcpServers = filterMcpServers(mcpServers, agentProfile.mcpServers);
  const profiledShellTools = filterShellTools(shellTools.tools, agentProfile.shellTools ?? []);
  const profiledSkillPaths = filterSkills(listSkillPaths(assetsRoot), agentProfile.skills);
  const profiledPluginPaths = filterPlugins(listPluginPaths(assetsRoot), agentProfile.plugins);
  const resourceHash = computeResourceHash({
    assetsRoot,
    agentId,
    agentProfile,
    mcpServers: profiledMcpServers,
    shellTools: profiledShellTools,
    skillPaths: profiledSkillPaths,
    pluginPaths: profiledPluginPaths,
  });
  const assetCommitHash = sha256Text([
    `agent:${agentId}`,
    `agentProfile:${JSON.stringify(agentProfile)}`,
    `resource:${resourceHash}`,
    `run:${runId}`,
    `mcpBindings:${JSON.stringify(mcpServerBindings)}`,
  ].join("\n"));
  const mountHash = sha256Text(`assetCommit:${assetCommitHash}`);
  const mountId = `m_${mountHash.slice(0, 16)}`;
  const assetCommitId = `ac_${assetCommitHash.slice(0, 16)}`;
  const materializedMcpServers = materializeMcpServers({
    mountRoot,
    mcpServers: profiledMcpServers,
    assetsRoot,
    dynamicValues: buildMountDynamicValues({
      repoRoot,
      runRoot,
      mountRoot,
      artifactRoot,
      assetCommitId,
    }),
    mcpServerBindings,
  });
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

  safeSymlink(join(assetsRoot, CodexAssetLayout.agentsMd), join(mountRoot, "AGENTS.md"));
  const workerAgentPath = materializeWorkerAgent(assetsRoot, mountRoot);
  const roleAgentPaths = materializeRoleAgent(assetsRoot, mountRoot, agentId);

  const configText = generateCodexConfig({
    baseConfig: readFileSync(join(assetsRoot, agentProfile.config), "utf8"),
    mountRoot,
    artifactRoot,
    runId,
    assetCommitId,
    mcpServers: materializedMcpServers,
  });
  writeTextFile(join(mountRoot, ".codex", "config.toml"), configText);
  writeTextFile(join(mountRoot, ".codex", "hooks.json"), "{\n  \"hooks\": []\n}\n");

  const skillNames = materializeSkills(assetsRoot, mountRoot, profiledSkillPaths);
  const pluginNames = materializePlugins(assetsRoot, mountRoot, profiledPluginPaths);
  const shellMaterialization = materializeShellTools(mountRoot, profiledShellTools, assetsRoot);
  writePluginMarketplace(mountRoot, pluginNames);

  const mountManifest = buildMountManifest({
    agentId,
    agentProfile,
    assetCommitId,
    parentAssetCommitId: options.parentAssetCommitId,
    mountId,
    mountRoot,
    mcpServerBindings,
    trustedRoots,
    writableRoots,
    resourceHash,
    assetsRoot,
    mcpServers: materializedMcpServers,
    shellTools: shellMaterialization.shellTools,
    skillPaths: profiledSkillPaths,
    pluginPaths: profiledPluginPaths,
    shellWrappers: shellMaterialization.wrappers,
    skillNames,
    pluginNames,
    workerAgentPath,
    roleAgentPaths,
    issues: shellMaterialization.issues,
  });
  const manifestPath = join(mountRoot, "mount-manifest.json");
  writeJsonFile(manifestPath, mountManifest);

  return {
    agentId,
    agentProfile,
    assetCommitId,
    parentAssetCommitId: options.parentAssetCommitId,
    mountId,
    mountRoot,
    runRoot,
    artifactRoot,
    logsRoot,
    issues: shellMaterialization.issues,
    trustedRoots,
    writableRoots,
    mcpServerBindings,
    shellTools: shellMaterialization.shellTools,
    mcpServers: materializedMcpServers,
    skills: skillNames,
    plugins: pluginNames,
    manifestPath,
    resourceHash,
  };
}

function normalizeMcpServerBindings(
  bindings: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(bindings)
      .map(([server, serverBindings]) => [
        server,
        Object.fromEntries(
          Object.entries(serverBindings)
            .map(([key, value]) => [key, value.trim()] as const)
            .filter((entry) => entry[0].trim().length > 0 && entry[1].length > 0),
        ),
      ] as const)
      .filter((entry) => entry[0].trim().length > 0 && Object.keys(entry[1]).length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sanitizeAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid agentId for mount materialization: ${agentId}`);
  }
  return normalized;
}

function readAgentProfile(
  assetsRoot: string,
  agentId: string,
): AgentProfile {
  const profiles = readJsonFile<AgentProfilesFile>(join(assetsRoot, CodexAssetLayout.agentProfiles));
  const profile = profiles.profiles[agentId];
  if (!profile) {
    throw new Error(`No agent profile configured for agent: ${agentId}`);
  }
  return {
    config: profile.config,
    skills: [...profile.skills],
    shellTools: [...(profile.shellTools ?? [])],
    mcpServers: [...profile.mcpServers],
    plugins: [...profile.plugins],
    trustedRoots: [...(profile.trustedRoots ?? [])],
    writableRoots: [...(profile.writableRoots ?? [])],
  };
}

function assertAssetFileExists(assetsRoot: string, assetPath: string, label: string): void {
  if (!existsSync(join(assetsRoot, assetPath))) {
    throw new Error(`Agent profile references missing ${label}: ${assetPath}`);
  }
}

function filterMcpServers(mcpServers: McpServersFile, names: string[]): McpServersFile {
  assertUnique(names, "mcpServers");
  const servers = Object.fromEntries(names.map((name) => {
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
    return tool;
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

function computeResourceHash(input: {
  assetsRoot: string;
  agentId: string;
  agentProfile: AgentProfile;
  mcpServers: McpServersFile;
  shellTools: ShellToolContract[];
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
    `shell:${sha256File(join(input.assetsRoot, CodexAssetLayout.shellTools))}`,
    ...computeShellToolResourceHashParts(input.assetsRoot, input.shellTools),
    ...hashVendorDirectories(input.assetsRoot),
    `workerAgent:${CodexAssetLayout.workerAgent}:${sha256File(join(input.assetsRoot, CodexAssetLayout.workerAgent))}`,
    `roleAgent:${input.agentId}:${roleAgentPath(input.agentId)}:${sha256File(join(input.assetsRoot, roleAgentPath(input.agentId)))}`,
    ...input.skillPaths.map((skill) => `skill:${skill}:${sha256File(join(input.assetsRoot, skill))}`),
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
    for (const arg of server.args ?? []) {
      if (!arg.startsWith("assets/")) continue;
      const path = resolveAssetArg(arg, assetsRoot);
      parts.push(`mcpServer:${name}:${arg}:${sha256File(path)}`);
      const vendorRoot = join(dirname(path), "vendor");
      if (existsSync(vendorRoot)) {
        parts.push(`mcpServerVendor:${name}:${relative(assetsRoot, vendorRoot)}:${hashDirectory(vendorRoot)}`);
      }
    }
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
  const resolvedPath = resolveAssetArg(assetPath, assetsRoot);
  if (!existsSync(resolvedPath)) return [];
  return [`${prefix}:${assetPath}:${sha256File(resolvedPath)}`];
}

function materializeSkills(assetsRoot: string, mountRoot: string, skills: string[]): string[] {
  return skills.map((skillPath) => {
    const source = join(assetsRoot, skillPath);
    const name = skillNameFromPath(skillPath);
    safeSymlink(resolve(source, ".."), join(mountRoot, ".agents", "skills", name));
    return name;
  });
}

function skillNameFromPath(skillPath: string): string {
  const source = resolve(skillPath);
  return basename(source) === "SKILL.md" ? basename(resolve(source, "..")) : basename(source);
}

function materializePlugins(assetsRoot: string, mountRoot: string, plugins: string[]): string[] {
  return plugins.map((pluginPath) => {
    const source = join(assetsRoot, pluginPath);
    const name = basename(source);
    safeSymlink(source, join(mountRoot, "plugins", name));
    return name;
  });
}

function materializeWorkerAgent(
  assetsRoot: string,
  mountRoot: string,
): string {
  const targetPath = join("agents", "worker.AGENTS.md");
  safeSymlink(join(assetsRoot, CodexAssetLayout.workerAgent), join(mountRoot, targetPath));
  return targetPath;
}

function materializeRoleAgent(
  assetsRoot: string,
  mountRoot: string,
  role: string,
): Record<string, string> {
  const agentPath = roleAgentPath(role);
  assertAssetFileExists(assetsRoot, agentPath, `AGENTS instructions for agent role ${role}`);
  const targetPath = join("agents", `${role}.AGENTS.md`);
  safeSymlink(join(assetsRoot, agentPath), join(mountRoot, targetPath));
  return { [role]: targetPath };
}

function resolveAssetArg(arg: string, assetsRoot: string): string {
  return arg.startsWith("assets/") ? join(resolve(assetsRoot, "..", ".."), arg) : arg;
}

function buildMountManifest(input: {
  agentId: string;
  agentProfile: AgentProfile;
  assetCommitId: string;
  parentAssetCommitId?: string;
  mountId: string;
  mountRoot: string;
  mcpServerBindings: Record<string, Record<string, string>>;
  trustedRoots: string[];
  writableRoots: string[];
  issues: MountMaterializationIssue[];
  resourceHash: string;
  assetsRoot: string;
  mcpServers: MaterializedMcpServer[];
  shellTools: ShellToolContract[];
  skillPaths: string[];
  pluginPaths: string[];
  shellWrappers: Array<{ id: string; wrapperPath: string }>;
  skillNames: string[];
  pluginNames: string[];
  workerAgentPath: string;
  roleAgentPaths: Record<string, string>;
}): MountManifest {
  const linkedFiles = [
    {
      path: "AGENTS.md",
      sourcePath: assetSourcePath(CodexAssetLayout.agentsMd),
      hash: sha256File(join(input.assetsRoot, CodexAssetLayout.agentsMd)),
    },
    {
      path: input.workerAgentPath,
      sourcePath: assetSourcePath(CodexAssetLayout.workerAgent),
      hash: sha256File(join(input.mountRoot, input.workerAgentPath)),
    },
    ...Object.entries(input.roleAgentPaths).map(([role, path]) => ({
      path,
      sourcePath: assetSourcePath(roleAgentPath(role)),
      hash: sha256File(join(input.mountRoot, path)),
    })),
  ];

  const generatedFiles = [
    ".codex/config.toml",
    ".codex/hooks.json",
    ".agents/plugins/marketplace.json",
  ].map((path) => ({
    path,
    hash: sha256File(join(input.mountRoot, path)),
  }));

  for (const wrapper of input.shellWrappers) {
    generatedFiles.push({
      path: relative(input.mountRoot, wrapper.wrapperPath),
      hash: sha256File(wrapper.wrapperPath),
    });
  }
  for (const server of input.mcpServers) {
    generatedFiles.push({
      path: relative(input.mountRoot, server.wrapperPath),
      hash: sha256File(server.wrapperPath),
    });
  }

  return {
    agentId: input.agentId,
    assetCommitId: input.assetCommitId,
    parentAssetCommitId: input.parentAssetCommitId,
    mountId: input.mountId,
    agentProfile: input.agentProfile,
    mountRoot: ".",
    mcpServerBindings: input.mcpServerBindings,
    trustedRoots: input.trustedRoots.map((root) => relativeOrSelf(input.mountRoot, root)),
    writableRoots: input.writableRoots.map((root) => relativeOrSelf(input.mountRoot, root)),
    resourceHash: input.resourceHash,
    generatedAt: new Date().toISOString(),
    issues: input.issues,
    assets: [
      {
        id: "codex.agents.default",
        type: "agents_md",
        sourcePath: assetSourcePath(CodexAssetLayout.agentsMd),
        hash: sha256File(join(input.assetsRoot, CodexAssetLayout.agentsMd)),
      },
      {
        id: "codex.agents.worker",
        type: "worker_agents_md",
        sourcePath: assetSourcePath(CodexAssetLayout.workerAgent),
        hash: sha256File(join(input.assetsRoot, CodexAssetLayout.workerAgent)),
      },
      {
        id: `codex.agents.profile.${input.agentId}`,
        type: "agent_profile",
        sourcePath: assetSourcePath(CodexAssetLayout.agentProfiles),
        hash: sha256File(join(input.assetsRoot, CodexAssetLayout.agentProfiles)),
      },
      ...Object.entries(input.roleAgentPaths).map(([role, path]) => ({
        id: `codex.agents.${role}`,
        type: "role_agents_md",
        sourcePath: assetSourcePath(roleAgentPath(role)),
        hash: sha256File(join(input.assetsRoot, roleAgentPath(role))),
      })),
      {
        id: `codex.config.${input.agentId}`,
        type: "config",
        sourcePath: assetSourcePath(input.agentProfile.config),
        hash: sha256File(join(input.assetsRoot, input.agentProfile.config)),
      },
      {
        id: "mcp.servers",
        type: "mcp_server_config",
        sourcePath: assetSourcePath(CodexAssetLayout.mcpServers),
        hash: sha256File(join(input.assetsRoot, CodexAssetLayout.mcpServers)),
      },
      {
        id: "codex.shell_tools",
        type: "shell_tool_contract",
        sourcePath: assetSourcePath(CodexAssetLayout.shellTools),
        hash: sha256File(join(input.assetsRoot, CodexAssetLayout.shellTools)),
      },
      ...input.skillPaths.map((skillPath) => ({
        id: `codex.skill.${skillNameFromPath(skillPath)}`,
        type: "skill",
        sourcePath: assetSourcePath(skillPath),
        hash: sha256File(join(input.assetsRoot, skillPath)),
      })),
      ...input.pluginPaths.map((pluginPath) => ({
        id: `codex.plugin.${basename(pluginPath)}`,
        type: "plugin",
        sourcePath: assetSourcePath(pluginPath),
        hash: hashDirectory(join(input.assetsRoot, pluginPath)),
      })),
    ],
    linkedFiles,
    generatedFiles,
    shellTools: input.shellTools.map((tool) => ({
      id: tool.id,
      exposeAs: tool.exposeAs,
      wrapperPath: `bin/${tool.exposeAs}`,
      command: tool.command,
      required: tool.required,
      marker: tool.marker,
    })),
    mcpServers: input.mcpServers.map((server) => ({
      name: server.name,
      wrapperPath: relative(input.mountRoot, server.wrapperPath),
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: server.env,
      bindings: server.bindings,
      trustedRoots: server.trustedRoots,
      writableRoots: server.writableRoots,
      smoke: server.smoke,
    })),
    skills: input.skillNames,
    plugins: input.pluginNames,
    workerAgent: input.workerAgentPath,
    roleAgents: input.roleAgentPaths,
  };
}

function assetSourcePath(assetPath: string): string {
  return join("assets", "codex", assetPath);
}

function relativeOrSelf(base: string, target: string): string {
  const relativePath = relative(base, target);
  return relativePath.length === 0 ? "." : relativePath;
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

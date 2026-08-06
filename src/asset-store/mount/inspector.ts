import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sha256File } from "../../core/fs.js";
import { isPathWithin } from "../../core/path.js";
import type {
  MountManifest,
  MountPreparationInspection,
  ShellToolContract,
} from "../types.js";
import { CodexAssetLayout, roleAgentPath } from "../assets/asset-layout.js";
import {
  buildMountDynamicValues,
  resolveAssetArg,
  resolveCommand,
  resolveAssetLocalPath,
  resolveShellToolCommand,
} from "./helpers.js";
import { resolveMountMacros } from "./macros.js";
import {
  assetSourcePath,
  customAgentNameFromPath,
  resolveAssetRelativePath,
  relativeOrSelf,
  skillNameFromPath,
  type MountContext,
  type MaterializeOptions,
} from "./context-builder.js";
import { MountManifestBuilder } from "./manifest-builder.js";

export class MountInspector {
  constructor(
    private readonly context: MountContext,
    private readonly existingManifest: MountManifest | undefined,
    private readonly persistedIdentity?: MaterializeOptions["persistedIdentity"],
  ) {}

  inspect(): MountPreparationInspection {
    const context = this.context;
    const existingManifest = this.existingManifest;
    const persistedIdentity = this.persistedIdentity;
    const reusable = existingManifest
      ? inspectReusableMount(context, existingManifest, persistedIdentity)
      : { reusable: false, reason: "mount manifest is missing" };
    if (
      existingManifest
      && !reusable.reusable
      && existingManifest.resourceInventoryVersion === 1
      && !persistedIdentity?.allowLegacyResourceIdentityMigration
      && (persistedIdentity?.resourceHash ?? existingManifest.resourceHash) !== context.resourceHash
    ) {
      throw new Error(`Persisted asset changed for ${context.agentId}: resource inventory`);
    }
    return {
      decision: reusable.reusable ? "reused" : "rebuild",
      reason: reusable.reason,
    };
  }
}

function inspectReusableMount(
  context: MountContext,
  manifest: MountManifest,
  persistedIdentity?: MaterializeOptions["persistedIdentity"],
): { reusable: boolean; reason?: string } {
  if (manifest.resourceInventoryVersion !== 1) return { reusable: false, reason: "legacy mount manifest" };
  if (manifest.mountRoot !== ".") return { reusable: false, reason: "mount manifest is not portable" };
  if (manifest.agentId !== context.agentId || manifest.mountId !== context.mountId
    || manifest.assetCommitId !== context.assetCommitId
    || manifest.parentAssetCommitId !== context.parentAssetCommitId
    || manifest.resourceHash !== context.resourceHash
    || JSON.stringify(manifest.agentProfile) !== JSON.stringify(context.agentProfile)) {
    return { reusable: false, reason: "mount identity or profile changed" };
  }
  if (JSON.stringify(manifest.trustedRoots) !== JSON.stringify(context.trustedRoots.map((root) => relativeOrSelf(context.mountRoot, root)))
    || JSON.stringify(manifest.writableRoots) !== JSON.stringify(context.writableRoots.map((root) => relativeOrSelf(context.mountRoot, root)))) {
    return { reusable: false, reason: "profile roots changed" };
  }
  if (persistedIdentity && (persistedIdentity.resourceHash !== context.resourceHash
    && !persistedIdentity.allowLegacyResourceIdentityMigration)) {
    return { reusable: false, reason: "portable resource hash changed" };
  }
  const mountStat = existsSync(context.mountRoot) ? lstatSync(context.mountRoot) : undefined;
  const artifactStat = existsSync(context.artifactRoot) ? lstatSync(context.artifactRoot) : undefined;
  const logsStat = existsSync(context.logsRoot) ? lstatSync(context.logsRoot) : undefined;
  if (!mountStat?.isDirectory() || mountStat.isSymbolicLink()
    || !artifactStat?.isDirectory() || artifactStat.isSymbolicLink()
    || !logsStat?.isDirectory() || logsStat.isSymbolicLink()) {
    return { reusable: false, reason: "mount roots are incomplete" };
  }
  const requiredDirs = [
    ".codex",
    ".codex/agents",
    ".agents/skills",
    ".agents/plugins",
    ".scout/skills",
    "agents",
    "plugins",
    "bin",
    "mcp",
  ];
  if (!requiredDirs.every((path) => {
    const candidate = join(context.mountRoot, path);
    return existsSync(candidate) && lstatSync(candidate).isDirectory();
  })) {
    return { reusable: false, reason: "mount layout is incomplete" };
  }
  try {
    const inventoryIssue = inspectManifestInventory(context, manifest);
    if (inventoryIssue) return { reusable: false, reason: inventoryIssue };
    const assetIssue = inspectAssetInventory(context, manifest.assets);
    if (assetIssue) return { reusable: false, reason: assetIssue };
    for (const asset of manifest.assets) {
      if (asset.id === "codex.shell_tools" && asset.type === "shell_tool_contract") continue;
      const source = resolveAssetLocalPath(asset.sourcePath, context.assetsRoot);
      if (!isPathWithin(context.assetsRoot, source)) {
        return { reusable: false, reason: `asset source escapes assets root ${asset.sourcePath}` };
      }
      if (!existsSync(source)) return { reusable: false, reason: `missing asset ${asset.sourcePath}` };
    }
    for (const linked of manifest.linkedFiles) {
      const target = join(context.mountRoot, linked.path);
      if (!lstatSync(target).isSymbolicLink()) return { reusable: false, reason: `linked file is not a symlink ${linked.path}` };
      const expected = resolve(context.repoRoot, linked.sourcePath);
      if (resolve(context.mountRoot, readlinkSync(target)) !== expected) return { reusable: false, reason: `link target changed ${linked.path}` };
      if (sha256File(target) !== linked.hash) return { reusable: false, reason: `linked file changed ${linked.path}` };
    }
    for (const generated of manifest.generatedFiles) {
      const path = join(context.mountRoot, generated.path);
      if (!existsSync(path) || !lstatSync(path).isFile() || sha256File(path) !== generated.hash) {
        return { reusable: false, reason: `generated file changed ${generated.path}` };
      }
    }
    const config = readFileSync(join(context.mountRoot, ".codex", "config.toml"), "utf8");
    if (!config.includes(context.mountRoot) || !config.includes(context.runRoot) || !config.includes(context.artifactRoot)) {
      return { reusable: false, reason: "config runtime paths changed" };
    }
    for (const tool of context.profiledShellTools) {
      const path = join(context.mountRoot, "bin", tool.exposeAs);
      if (!existsSync(path)) {
        if (tool.required) return { reusable: false, reason: `required shell tool missing ${tool.id}` };
        continue;
      }
      const script = readFileSync(path, "utf8");
      const expected = resolveShellToolCommand(tool, context.assetsRoot);
      if (!expected) {
        if (tool.required) return { reusable: false, reason: `shell runtime is unavailable ${tool.id}` };
        continue;
      }
      if (!script.includes(expected)) return { reusable: false, reason: `shell runtime binding changed ${tool.id}` };
    }
    for (const server of Object.entries(context.profiledMcpServers.servers)) {
      const path = join(context.mountRoot, "mcp", server[0]);
      if (!existsSync(path)) return { reusable: false, reason: `MCP wrapper missing ${server[0]}` };
      const script = readFileSync(path, "utf8");
      const expected = resolveCommand(server[1].command, context.assetsRoot);
      if (!script.includes(expected)) return { reusable: false, reason: `MCP runtime binding changed ${server[0]}` };
    }
  } catch {
    return { reusable: false, reason: "mount verification failed" };
  }
  return { reusable: true };
}

function inspectAssetInventory(
  context: MountContext,
  actual: MountManifest["assets"],
): string | undefined {
  const expected = new MountManifestBuilder({
    agentId: context.agentId,
    agentProfile: context.agentProfile,
    assetsRoot: context.assetsRoot,
    mcpServerContracts: context.profiledMcpServers,
    shellToolContracts: context.profiledShellTools,
    customAgentPaths: context.profiledCustomAgentPaths,
    skillPaths: context.profiledSkillPaths,
    pluginPaths: context.profiledPluginPaths,
    workerAgentPath: context.agentId === "coordinator"
      ? undefined
      : join("agents", "worker.AGENTS.md"),
    roleAgentPaths: {
      [context.agentId]: join("agents", context.agentId + ".AGENTS.md"),
    },
    shellToolsRegistryHash: sha256File(
      resolveAssetRelativePath(CodexAssetLayout.shellTools, context.assetsRoot),
    ),
  }).buildAssetInventory();
  if (!Array.isArray(actual) || actual.length !== expected.length) return "asset inventory changed";
  const actualById = new Map<string, MountManifest["assets"][number]>();
  for (const asset of actual) {
    if (actualById.has(asset.id)) return `duplicate asset id: ${asset.id}`;
    actualById.set(asset.id, asset);
  }
  for (const expectedAsset of expected) {
    const actualAsset = actualById.get(expectedAsset.id);
    if (!actualAsset
      || actualAsset.type !== expectedAsset.type
      || actualAsset.sourcePath !== expectedAsset.sourcePath) {
      return `asset identity changed: ${expectedAsset.id}`;
    }
    // The shell-tools registry is intentionally not part of portable identity.
    if (expectedAsset.id !== "codex.shell_tools" && actualAsset.hash !== expectedAsset.hash) {
      return `asset hash changed: ${expectedAsset.id}`;
    }
  }
  return undefined;
}

function inspectManifestInventory(context: MountContext, manifest: MountManifest): string | undefined {
  if (manifest.issues.some((issue) => issue.severity === "error")) return "mount contains materialization errors";
  if (!sameStrings(manifest.customAgents, context.profiledCustomAgentPaths.map(customAgentNameFromPath))) {
    return "custom agent inventory changed";
  }
  if (!sameStrings(manifest.skills, context.profiledSkillPaths.map(skillNameFromPath))) {
    return "skill inventory changed";
  }
  if (!sameStrings(manifest.plugins, context.profiledPluginPaths.map((path) => basename(path)))) {
    return "plugin inventory changed";
  }
  if (JSON.stringify(manifest.skillCatalog) !== JSON.stringify(context.skillCatalog)) return "skill catalog changed";

  const expectedLinkedFiles = new Map<string, string>([
    ["AGENTS.md", assetSourcePath(CodexAssetLayout.agentsMd)],
    ...(context.agentId === "coordinator"
      ? []
      : [[
        join("agents", "worker.AGENTS.md"),
        assetSourcePath(CodexAssetLayout.workerAgent),
      ]] as Array<[string, string]>),
    [join("agents", context.agentId + ".AGENTS.md"), assetSourcePath(roleAgentPath(context.agentId))],
    ...context.profiledCustomAgentPaths.map((path) => [
      join(".codex", "agents", customAgentNameFromPath(path) + ".toml"),
      assetSourcePath(path),
    ] as [string, string]),
  ]);
  if (!sameStrings(manifest.linkedFiles.map((file) => file.path), [...expectedLinkedFiles.keys()])) {
    return "linked file inventory changed";
  }
  if (manifest.linkedFiles.some((file) => expectedLinkedFiles.get(file.path) !== file.sourcePath)) {
    return "linked file source changed";
  }

  const expectedGeneratedPaths = [
    ".codex/config.toml",
    ".codex/hooks.json",
    ".agents/plugins/marketplace.json",
    ".scout/skill-catalog.json",
    ...resolvedShellToolEntries(context).map((tool) => join("bin", tool.exposeAs)),
    ...Object.keys(context.profiledMcpServers.servers).map((name) => join("mcp", name)),
  ].sort();
  if (!sameStrings(manifest.generatedFiles.map((file) => file.path), expectedGeneratedPaths)) {
    return "generated file inventory changed";
  }
  const expectedRoleAgents = { [context.agentId]: join("agents", context.agentId + ".AGENTS.md") };
  if (JSON.stringify(manifest.roleAgents) !== JSON.stringify(expectedRoleAgents)) return "role agent inventory changed";
  const expectedWorkerAgent = context.agentId === "coordinator" ? undefined : join("agents", "worker.AGENTS.md");
  if (manifest.workerAgent !== expectedWorkerAgent) return "worker agent inventory changed";

  const shellEntries = resolvedShellToolEntries(context);
  if (!sameStrings(manifest.shellTools.map((tool) => tool.id), shellEntries.map((tool) => tool.id))) {
    return "shell tool inventory changed";
  }
  if (!sameStrings(readdirSync(join(context.mountRoot, "bin")), shellEntries.map((tool) => tool.exposeAs))) {
    return "shell tool layout changed";
  }
  for (const tool of shellEntries) {
    const persisted = manifest.shellTools.find((candidate) => candidate.id === tool.id);
    if (!persisted
      || persisted.exposeAs !== tool.exposeAs
      || persisted.wrapperPath !== join("bin", tool.exposeAs)
      || persisted.command !== tool.contract.command
      || persisted.required !== tool.contract.required
      || persisted.marker !== tool.contract.marker) {
      return "shell tool contract changed: " + tool.id;
    }
    const wrapperPath = join(context.mountRoot, "bin", tool.exposeAs);
    if (!existsSync(wrapperPath) || !lstatSync(wrapperPath).isFile()) return "shell tool wrapper missing: " + tool.id;
    const expectedInvocation = "exec " + JSON.stringify(tool.command) + " "
      + tool.args.map((arg) => JSON.stringify(arg)).join(" ") + " \"$@\"";
    if (!readFileSync(wrapperPath, "utf8").includes(expectedInvocation)) return "shell tool wrapper changed: " + tool.id;
  }

  const mcpEntries = Object.entries(context.profiledMcpServers.servers);
  if (!sameStrings(manifest.mcpServers.map((server) => server.name), mcpEntries.map(([name]) => name))) {
    return "MCP server inventory changed";
  }
  if (!sameStrings(readdirSync(join(context.mountRoot, "mcp")), mcpEntries.map(([name]) => name))) {
    return "MCP server layout changed";
  }
  for (const [name, contract] of mcpEntries) {
    const persisted = manifest.mcpServers.find((server) => server.name === name);
    const dynamicValues = mountDynamicValues(context);
    const expectedCommand = resolveCommand(resolveMountMacros(contract.command, dynamicValues), context.assetsRoot);
    const expectedArgs = (contract.args ?? [])
      .map((arg) => resolveMountMacros(arg, dynamicValues))
      .filter((arg) => arg.length > 0)
      .map((arg) => resolveAssetArg(arg, context.assetsRoot));
    const expectedCwd = contract.cwd ? resolveMountMacros(contract.cwd, dynamicValues) : undefined;
    const expectedEnv = contract.env
      ? Object.fromEntries(Object.entries(contract.env)
        .map(([key, value]) => [key, resolveMountMacros(value, dynamicValues)] as const)
        .filter((entry) => entry[1].length > 0))
      : undefined;
    const expectedTrustedRoots = (contract.trustedRoots ?? [])
      .map((root) => resolveMountMacros(root, dynamicValues))
      .filter((root) => root.length > 0)
      .map((root) => resolve(root));
    const expectedWritableRoots = (contract.writableRoots ?? [])
      .map((root) => resolveMountMacros(root, dynamicValues))
      .filter((root) => root.length > 0)
      .map((root) => resolve(root));
    const expectedSmoke = contract.smoke
      ? { tool: contract.smoke.tool, arguments: resolveMountDynamicValue(contract.smoke.arguments ?? {}, dynamicValues) }
      : undefined;
    if (!persisted
      || persisted.wrapperPath !== join("mcp", name)
      || persisted.command !== expectedCommand
      || JSON.stringify(persisted.args) !== JSON.stringify(expectedArgs)
      || persisted.cwd !== expectedCwd
      || JSON.stringify(persisted.env) !== JSON.stringify(expectedEnv)
      || JSON.stringify(persisted.trustedRoots) !== JSON.stringify(expectedTrustedRoots)
      || JSON.stringify(persisted.writableRoots) !== JSON.stringify(expectedWritableRoots)
      || JSON.stringify(persisted.smoke) !== JSON.stringify(expectedSmoke)) {
      return "MCP server contract changed: " + name;
    }
    const wrapperPath = join(context.mountRoot, "mcp", name);
    if (!existsSync(wrapperPath) || !lstatSync(wrapperPath).isFile()) return "MCP wrapper missing: " + name;
    const expectedInvocation = "exec " + JSON.stringify(expectedCommand) + " "
      + expectedArgs.map((arg) => JSON.stringify(arg)).join(" ") + " \"$@\"";
    if (!readFileSync(wrapperPath, "utf8").includes(expectedInvocation)) return "MCP wrapper changed: " + name;
  }

  for (const skillPath of context.profiledSkillPaths) {
    const name = skillNameFromPath(skillPath);
    if (!assertCurrentSymlink(join(context.mountRoot, ".scout", "skills", name), resolve(context.assetsRoot, dirname(skillPath)))) {
      return "skill link changed: " + name;
    }
  }
  if (!sameStrings(readdirSync(join(context.mountRoot, ".scout", "skills")), context.profiledSkillPaths.map(skillNameFromPath))) {
    return "skill link inventory changed";
  }
  for (const pluginPath of context.profiledPluginPaths) {
    const name = basename(pluginPath);
    if (!assertCurrentSymlink(join(context.mountRoot, "plugins", name), resolve(context.assetsRoot, pluginPath))) {
      return "plugin link changed: " + name;
    }
  }
  if (!sameStrings(
    readdirSync(join(context.mountRoot, "plugins")),
    context.profiledPluginPaths.map((path) => basename(path)),
  )) {
    return "plugin link inventory changed";
  }
  return undefined;
}

function sameStrings(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function resolvedShellToolEntries(context: MountContext): Array<{
  id: string;
  exposeAs: string;
  command: string;
  args: string[];
  contract: ShellToolContract;
}> {
  return context.profiledShellTools.flatMap((contract) => {
    const command = resolveShellToolCommand(contract, context.assetsRoot);
    if (!command) return [];
    return [{
      id: contract.id,
      exposeAs: contract.exposeAs,
      command,
      args: (contract.args ?? []).map((arg) => resolveAssetArg(arg, context.assetsRoot)),
      contract,
    }];
  });
}

function mountDynamicValues(context: MountContext): Record<string, string | undefined> {
  return buildMountDynamicValues({
    repoRoot: context.repoRoot,
    runRoot: context.runRoot,
    mountRoot: context.mountRoot,
    artifactRoot: context.artifactRoot,
    assetCommitId: context.assetCommitId,
  });
}

function resolveMountDynamicValue(
  value: unknown,
  dynamicValues: Record<string, string | undefined>,
): unknown {
  if (typeof value === "string") return resolveMountMacros(value, dynamicValues);
  if (Array.isArray(value)) return value.map((item) => resolveMountDynamicValue(item, dynamicValues));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    resolveMountDynamicValue(child, dynamicValues),
  ]));
}

function assertCurrentSymlink(path: string, expectedTarget: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
      && resolve(dirname(path), readlinkSync(path)) === expectedTarget;
  } catch {
    return false;
  }
}

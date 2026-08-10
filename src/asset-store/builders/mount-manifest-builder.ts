import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hashDirectory, sha256File } from "../../core/fs.js";
import type {
  MaterializedMcpServer,
  McpServersFile,
  ShellToolContract,
} from "../contracts/resources.js";
import type { AgentProfile } from "../contracts/profile.js";
import type { MountManifest } from "../contracts/manifest.js";
import type { MountMaterializationIssue } from "../contracts/mount.js";
import { CodexAssetLayout, roleAgentPath } from "../assets/asset-layout.js";
import {
  assertMountPathSegment,
  assetSourcePath,
  customAgentNameFromPath,
  resolveAssetRelativePath,
  resolveRequiredAssetFile,
  relativeOrSelf,
  skillNameFromPath,
} from "../files/asset-paths.js";

/** Inputs describing the selected source resources before mount files exist. */
export interface AssetInventoryInput {
  agentId: string;
  agentProfile: AgentProfile;
  assetsRoot: string;
  mcpServerContracts: McpServersFile;
  shellToolContracts: ShellToolContract[];
  customAgentPaths: string[];
  skillPaths: string[];
  pluginPaths: string[];
  workerAgentPath?: string;
  roleAgentPaths: Record<string, string>;
  shellToolsRegistryHash: string;
}

/** Materialized paths and identity fields combined with the source inventory. */
export type MountManifestInput = AssetInventoryInput & {
  assetCommitId: string;
  parentAssetCommitId?: string;
  mountId: string;
  mountRoot: string;
  trustedRoots: string[];
  writableRoots: string[];
  issues: MountMaterializationIssue[];
  resourceHash: string;
  mcpServers: MaterializedMcpServer[];
  shellTools: ShellToolContract[];
  shellWrappers: Array<{ id: string; wrapperPath: string }>;
  customAgentNames: string[];
  skillNames: string[];
  skillCatalog: MountManifest["skillCatalog"];
  pluginNames: string[];
};

/** Fields supplied after materialization when the manifest is assembled. */
export type MountManifestFields = Omit<MountManifestInput, keyof AssetInventoryInput>;

/** Builds portable source inventory and the generated mount manifest projection. */
export class MountManifestBuilder {
  constructor(private readonly inventoryInput: AssetInventoryInput) {}

  /** Hashes and describes every selected source resource. */
  buildAssetInventory(): MountManifest["assets"] {
    return buildAssetInventoryInternal(this.inventoryInput);
  }

  /** Combines source inventory with generated paths and mount identity metadata. */
  build(fields: MountManifestFields): MountManifest {
    return buildMountManifestInternal({ ...this.inventoryInput, ...fields });
  }
}

function buildAssetInventoryInternal(input: AssetInventoryInput): MountManifest["assets"] {
  const shellToolAssets = input.shellToolContracts.flatMap((tool) => {
    const assets: MountManifest["assets"] = [];
    const appendAsset = (kind: "command" | "arg", assetPath: string, index?: number) => {
      if (!assetPath.startsWith("assets/")) return;
      const sourcePath = resolveRequiredAssetFile(assetPath, input.assetsRoot);
      assets.push({
        id: `codex.shell_tool.${tool.id}.${kind}${index === undefined ? "" : `.${index}`}`,
        type: "shell_tool_resource",
        sourcePath: assetPath,
        hash: sha256File(sourcePath),
      });
    };
    appendAsset("command", tool.command);
    for (const [index, arg] of (tool.args ?? []).entries()) appendAsset("arg", arg, index);
    return assets;
  });

  const mcpServerAssets = Object.entries(input.mcpServerContracts.servers).flatMap(
    ([name, server]) => {
      assertMountPathSegment(name, "MCP server name");
      const assets: MountManifest["assets"] = [];
      const appendAsset = (kind: "command" | "arg", assetPath: string, index?: number) => {
        if (!assetPath.startsWith("assets/")) return;
        const sourcePath = resolveRequiredAssetFile(assetPath, input.assetsRoot);
        const idSuffix = `${kind}${index === undefined ? "" : `.${index}`}`;
        assets.push({
          id: `codex.mcp_server.${name}.${idSuffix}`,
          type: "mcp_server_resource",
          sourcePath: assetPath,
          hash: sha256File(sourcePath),
        });
        const vendorRoot = join(dirname(sourcePath), "vendor");
        if (existsSync(vendorRoot)) {
          assets.push({
            id: `codex.mcp_server.${name}.${idSuffix}.vendor`,
            type: "mcp_server_vendor",
            sourcePath: relative(resolve(input.assetsRoot, "..", ".."), vendorRoot),
            hash: hashDirectory(vendorRoot),
          });
        }
      };
      appendAsset("command", server.command);
      for (const [index, arg] of (server.args ?? []).entries()) appendAsset("arg", arg, index);
      return assets;
    },
  );

  return [
    {
      id: "codex.agents.default",
      type: "agents_md",
      sourcePath: assetSourcePath(CodexAssetLayout.agentsMd),
      hash: sha256File(resolveAssetRelativePath(CodexAssetLayout.agentsMd, input.assetsRoot)),
    },
    ...(input.workerAgentPath
      ? [{
          id: "codex.agents.worker",
          type: "worker_agents_md",
          sourcePath: assetSourcePath(CodexAssetLayout.workerAgent),
          hash: sha256File(resolveAssetRelativePath(CodexAssetLayout.workerAgent, input.assetsRoot)),
        }]
      : []),
    {
      id: `codex.agents.profile.${input.agentId}`,
      type: "agent_profile",
      sourcePath: assetSourcePath(CodexAssetLayout.agentProfiles),
      hash: sha256File(resolveAssetRelativePath(CodexAssetLayout.agentProfiles, input.assetsRoot)),
    },
    ...Object.entries(input.roleAgentPaths).map(([role]) => ({
      id: `codex.agents.${role}`,
      type: "role_agents_md",
      sourcePath: assetSourcePath(roleAgentPath(role)),
      hash: sha256File(resolveAssetRelativePath(roleAgentPath(role), input.assetsRoot)),
    })),
    {
      id: `codex.config.${input.agentId}`,
      type: "config",
      sourcePath: assetSourcePath(input.agentProfile.config),
      hash: sha256File(resolveAssetRelativePath(input.agentProfile.config, input.assetsRoot)),
    },
    ...input.customAgentPaths.map((path) => ({
      id: `codex.custom_agent.${customAgentNameFromPath(path)}`,
      type: "custom_agent",
      sourcePath: assetSourcePath(path),
      hash: sha256File(resolveAssetRelativePath(path, input.assetsRoot)),
    })),
    {
      id: "mcp.servers",
      type: "mcp_server_config",
      sourcePath: assetSourcePath(CodexAssetLayout.mcpServers),
      hash: sha256File(resolveAssetRelativePath(CodexAssetLayout.mcpServers, input.assetsRoot)),
    },
    {
      id: "codex.shell_tools",
      type: "shell_tool_contract",
      sourcePath: assetSourcePath(CodexAssetLayout.shellTools),
      hash: input.shellToolsRegistryHash,
    },
    ...shellToolAssets,
    ...mcpServerAssets,
    ...input.skillPaths.map((skillPath) => ({
      id: `codex.skill.${skillNameFromPath(skillPath)}`,
      type: "skill",
      sourcePath: assetSourcePath(dirname(skillPath)),
      hash: hashDirectory(resolveAssetRelativePath(dirname(skillPath), input.assetsRoot)),
    })),
    ...input.pluginPaths.map((pluginPath) => ({
      id: `codex.plugin.${basename(pluginPath)}`,
      type: "plugin",
      sourcePath: assetSourcePath(pluginPath),
      hash: hashDirectory(resolveAssetRelativePath(pluginPath, input.assetsRoot)),
    })),
  ];
}

function buildMountManifestInternal(input: MountManifestInput): MountManifest {
  const linkedFiles = [
    {
      path: "AGENTS.md",
      sourcePath: assetSourcePath(CodexAssetLayout.agentsMd),
      hash: sha256File(join(input.assetsRoot, CodexAssetLayout.agentsMd)),
    },
    ...(input.workerAgentPath
      ? [{
          path: input.workerAgentPath,
          sourcePath: assetSourcePath(CodexAssetLayout.workerAgent),
          hash: sha256File(join(input.mountRoot, input.workerAgentPath)),
        }]
      : []),
    ...Object.entries(input.roleAgentPaths).map(([role, path]) => ({
      path,
      sourcePath: assetSourcePath(roleAgentPath(role)),
      hash: sha256File(join(input.mountRoot, path)),
    })),
    ...input.customAgentPaths.map((path) => ({
      path: join(".codex", "agents", `${customAgentNameFromPath(path)}.toml`),
      sourcePath: assetSourcePath(path),
      hash: sha256File(join(input.assetsRoot, path)),
    })),
  ];

  const generatedFiles = [
    ".codex/config.toml",
    ".codex/hooks.json",
    ".agents/plugins/marketplace.json",
    ".scout/skill-catalog.json",
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
    resourceInventoryVersion: 1,
    agentId: input.agentId,
    assetCommitId: input.assetCommitId,
    parentAssetCommitId: input.parentAssetCommitId,
    mountId: input.mountId,
    agentProfile: input.agentProfile,
    mountRoot: ".",
    trustedRoots: input.trustedRoots.map((root) => relativeOrSelf(input.mountRoot, root)),
    writableRoots: input.writableRoots.map((root) => relativeOrSelf(input.mountRoot, root)),
    resourceHash: input.resourceHash,
    generatedAt: new Date().toISOString(),
    issues: input.issues,
    assets: buildAssetInventoryInternal(input),
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
      trustedRoots: server.trustedRoots,
      writableRoots: server.writableRoots,
      smoke: server.smoke,
    })),
    customAgents: input.customAgentNames,
    skills: input.skillNames,
    skillCatalog: input.skillCatalog,
    plugins: input.pluginNames,
    ...(input.workerAgentPath ? { workerAgent: input.workerAgentPath } : {}),
    roleAgents: input.roleAgentPaths,
  };
}

import { chmodSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  ensureDir,
  recreateDir,
  safeSymlink,
  sha256File,
  writeJsonFile,
  writeTextFile,
} from "../../core/fs.js";
import type {
  CodexMount,
} from "../contracts/mount.js";
import type { MountManifest } from "../contracts/manifest.js";
import type { MaterializeOptions } from "../contracts/materialization.js";
import type { MountContext } from "../contracts/mount-context.js";
import type { ShellToolContract } from "../contracts/resources.js";
import { CodexAssetLayout, roleAgentPath } from "../assets/asset-layout.js";
import { McpServerBuilder } from "../builders/mcp-server-builder.js";
import { MountGeneratedFilesBuilder } from "../builders/mount-generated-files-builder.js";
import { MountManifestBuilder } from "../builders/mount-manifest-builder.js";
import { ShellToolBuilder } from "../builders/shell-tool-builder.js";
import {
  assertAssetFileExists,
  customAgentNameFromPath,
  resolveAssetRelativePath,
  skillNameFromPath,
} from "../files/asset-paths.js";
import { buildMountMacroValues } from "./macros.js";

/**
 * Owns filesystem writes for one role mount. It creates links and generated
 * wrappers/configuration from an immutable MountContext; reuse decisions and
 * run lifecycle persistence are handled by MountPreparation and run stages.
 */
export class MountMaterializer {
  constructor(private readonly context: MountContext) {}

  /** Reconstructs a mount projection from a manifest without rewriting files. */
  buildReusableMount(manifest: MountManifest): CodexMount {
    const { context } = this;
    const shellToolsById = new Map(context.profiledShellTools.map((tool) => [tool.id, tool] as const));
    return {
      agentId: context.agentId,
      agentProfile: context.agentProfile,
      assetCommitId: context.assetCommitId,
      parentAssetCommitId: context.parentAssetCommitId,
      mountId: context.mountId,
      mountRoot: context.mountRoot,
      runRoot: context.runRoot,
      artifactRoot: context.artifactRoot,
      logsRoot: context.logsRoot,
      issues: manifest.issues,
      readableRoots: context.readableRoots,
      writableRoots: context.writableRoots,
      shellTools: manifest.shellTools
        .map((tool) => shellToolsById.get(tool.id))
        .filter((tool): tool is ShellToolContract => Boolean(tool)),
      mcpServers: manifest.mcpServers.map((server) => ({
        ...server,
        wrapperPath: join(context.mountRoot, "mcp", server.name),
      })),
      customAgents: manifest.customAgents,
      skills: manifest.skills,
      skillCatalog: manifest.skillCatalog,
      plugins: manifest.plugins,
      manifestPath: join(context.mountRoot, "mount-manifest.json"),
      resourceHash: context.resourceHash,
    };
  }

  /** Wipes/recreates the role mount, writes generated resources, and records a manifest. */
  materialize(options: MaterializeOptions): CodexMount {
    const context = this.context;
    const {
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
      readableRoots,
      writableRoots,
    } = context;
    const shellToolsRegistryHash = sha256File(join(assetsRoot, CodexAssetLayout.shellTools));
    if (
      options.persistedIdentity
      && !options.allowLegacyResourceIdentityMigration
      && options.persistedIdentity.resourceHash !== computedResourceHash
    ) {
      throw new Error(
        `Persisted resource identity does not match current assets for ${agentId}:`
        + ` persisted=${options.persistedIdentity.resourceHash}`
        + ` portable=${computedResourceHash}.`,
      );
    }
    const resourceHash = options.allowLegacyResourceIdentityMigration
      ? computedResourceHash
      : options.persistedIdentity?.resourceHash ?? computedResourceHash;

    ensureDir(runRoot);
    ensureDir(join(runRoot, "agents"));
    if (options.cleanRunRoot ?? true) recreateDir(agentRoot);
    else ensureDir(agentRoot);
    recreateDir(mountRoot);
    options.onMaterializationStep?.("wipe");
    ensureDir(artifactRoot);
    ensureDir(logsRoot);
    ensureDir(join(mountRoot, ".codex"));
    ensureDir(join(mountRoot, ".codex", "agents"));
    ensureDir(join(mountRoot, ".agents", "skills"));
    ensureDir(join(mountRoot, ".agents", "plugins"));
    ensureDir(join(mountRoot, ".scout", "skills"));
    ensureDir(join(mountRoot, "agents"));
    ensureDir(join(mountRoot, "plugins"));
    ensureDir(join(mountRoot, "bin"));
    ensureDir(join(mountRoot, "mcp"));

    const builtMcpServers = new McpServerBuilder({
      mountRoot,
      assetsRoot,
      dynamicValues: buildMountMacroValues({
        repoRoot,
        runRoot,
        mountRoot,
        artifactRoot,
        assetCommitId,
      }),
    }).build(profiledMcpServers);
    for (const builtServer of builtMcpServers) {
      writeTextFile(builtServer.server.wrapperPath, builtServer.wrapperContent);
      chmodSync(builtServer.server.wrapperPath, 0o755);
    }
    const materializedMcpServers = builtMcpServers.map(({ server }) => server);
    safeSymlink(join(assetsRoot, CodexAssetLayout.agentsMd), join(mountRoot, "AGENTS.md"));
    const workerAgentPath = agentId === "coordinator"
      ? undefined
      : materializeWorkerAgent(assetsRoot, mountRoot);
    const roleAgentPaths = materializeRoleAgent(assetsRoot, mountRoot, agentId);
    options.onMaterializationStep?.("layout");

    const generatedFiles = new MountGeneratedFilesBuilder(
      context,
      readFileSync(join(assetsRoot, agentProfile.config), "utf8"),
      materializedMcpServers,
    ).build();
    const generatedContent = (path: string): string => {
      const file = generatedFiles.find((candidate) => candidate.path === path);
      if (!file) throw new Error(`Generated mount file projection is missing: ${path}`);
      return file.content;
    };
    writeTextFile(
      join(mountRoot, ".codex", "config.toml"),
      generatedContent(".codex/config.toml"),
    );
    writeTextFile(
      join(mountRoot, ".codex", "hooks.json"),
      generatedContent(".codex/hooks.json"),
    );
    options.onMaterializationStep?.("config");

    const customAgentNames = materializeCustomAgents(assetsRoot, mountRoot, profiledCustomAgentPaths);
    const skillNames = materializeSkills(assetsRoot, mountRoot, profiledSkillPaths);
    writeTextFile(
      join(mountRoot, ".scout", "skill-catalog.json"),
      generatedContent(".scout/skill-catalog.json"),
    );
    options.onMaterializationStep?.("skills");
    const pluginNames = materializePlugins(assetsRoot, mountRoot, profiledPluginPaths);
    options.onMaterializationStep?.("plugins");
    const shellBuild = new ShellToolBuilder(mountRoot, assetsRoot).build(profiledShellTools);
    for (const builtTool of shellBuild.tools) {
      writeTextFile(builtTool.wrapperPath, builtTool.wrapperContent);
      chmodSync(builtTool.wrapperPath, 0o755);
    }
    writeTextFile(
      join(mountRoot, ".agents", "plugins", "marketplace.json"),
      generatedContent(".agents/plugins/marketplace.json"),
    );
    options.onMaterializationStep?.("shell");

    const manifestBuilder = new MountManifestBuilder({
      agentId,
      agentProfile,
      assetsRoot,
      mcpServerContracts: profiledMcpServers,
      shellToolContracts: profiledShellTools,
      customAgentPaths: profiledCustomAgentPaths,
      skillPaths: profiledSkillPaths,
      pluginPaths: profiledPluginPaths,
      workerAgentPath,
      roleAgentPaths,
      shellToolsRegistryHash,
    });
    const mountManifest = manifestBuilder.build({
      assetCommitId,
      parentAssetCommitId,
      mountId,
      mountRoot,
      readableRoots,
      writableRoots,
      issues: shellBuild.issues,
      resourceHash,
      mcpServers: materializedMcpServers,
      shellTools: shellBuild.tools.map(({ contract }) => contract),
      shellWrappers: shellBuild.tools.map(({ contract, wrapperPath }) => ({
        id: contract.id,
        wrapperPath,
      })),
      customAgentNames,
      skillNames,
      skillCatalog,
      pluginNames,
    });
    const manifestPath = join(mountRoot, "mount-manifest.json");
    writeJsonFile(manifestPath, mountManifest);

    return {
      agentId,
      agentProfile,
      assetCommitId,
      parentAssetCommitId,
      mountId,
      mountRoot,
      runRoot,
      artifactRoot,
      logsRoot,
      issues: shellBuild.issues,
      readableRoots,
      writableRoots,
      shellTools: shellBuild.tools.map(({ contract }) => contract),
      mcpServers: materializedMcpServers,
      customAgents: customAgentNames,
      skills: skillNames,
      skillCatalog,
      plugins: pluginNames,
      manifestPath,
      resourceHash,
    };
  }
}

/** Links selected Skill directories into the mount's Scout Skill namespace. */
function materializeSkills(assetsRoot: string, mountRoot: string, skills: string[]): string[] {
  return skills.map((skillPath) => {
    const source = resolveAssetRelativePath(skillPath, assetsRoot);
    const name = skillNameFromPath(skillPath);
    safeSymlink(resolve(source, ".."), join(mountRoot, ".scout", "skills", name));
    return name;
  });
}

/** Links selected custom-agent TOML files into Codex's mount-local agents directory. */
function materializeCustomAgents(
  assetsRoot: string,
  mountRoot: string,
  customAgents: string[],
): string[] {
  return customAgents.map((customAgentPath) => {
    const name = customAgentNameFromPath(customAgentPath);
    safeSymlink(
      resolveAssetRelativePath(customAgentPath, assetsRoot),
      join(mountRoot, ".codex", "agents", `${name}.toml`),
    );
    return name;
  });
}

/** Links selected plugin directories into the mount-local plugin namespace. */
function materializePlugins(assetsRoot: string, mountRoot: string, plugins: string[]): string[] {
  return plugins.map((pluginPath) => {
    const source = resolveAssetRelativePath(pluginPath, assetsRoot);
    const name = basename(source);
    safeSymlink(source, join(mountRoot, "plugins", name));
    return name;
  });
}

/** Links worker-only instructions and returns the manifest-relative target path. */
function materializeWorkerAgent(assetsRoot: string, mountRoot: string): string {
  const targetPath = join("agents", "worker.AGENTS.md");
  safeSymlink(
    resolveAssetRelativePath(CodexAssetLayout.workerAgent, assetsRoot),
    join(mountRoot, targetPath),
  );
  return targetPath;
}

/** Links the role-specific AGENTS file and returns its manifest-relative path. */
function materializeRoleAgent(
  assetsRoot: string,
  mountRoot: string,
  role: string,
): Record<string, string> {
  const agentPath = roleAgentPath(role);
  assertAssetFileExists(assetsRoot, agentPath, `AGENTS instructions for agent role ${role}`);
  const targetPath = join("agents", `${role}.AGENTS.md`);
  safeSymlink(resolveAssetRelativePath(agentPath, assetsRoot), join(mountRoot, targetPath));
  return { [role]: targetPath };
}

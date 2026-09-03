import { chmodSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
import type { MaterializedSkill, ResolvedScoutSkillCatalogEntry } from "../contracts/skill.js";
import { CodexAssetLayout } from "../assets/asset-layout.js";
import { SynthesisPhase } from "../../core/workflow/index.js";
import { McpServerBuilder } from "../builders/mcp-server-builder.js";
import { MountGeneratedFilesBuilder } from "../builders/mount-generated-files-builder.js";
import { MountManifestBuilder } from "../builders/mount-manifest-builder.js";
import { ShellToolBuilder } from "../builders/shell-tool-builder.js";
import {
  assertAssetFileExists,
  customAgentNameFromPath,
  relativeOrSelf,
  resolveAssetRelativePath,
  skillNameFromPath,
} from "../files/asset-paths.js";
import { createMountMacroValues } from "./macros.js";

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
    // The temp root is runtime-only and is intentionally absent from the
    // portable mount manifest; recreate it when a copied run reuses a mount.
    ensureDir(context.tempRoot);
    const shellToolsById = new Map(context.profiledShellTools.map((tool) => [tool.id, tool] as const));
    return {
      agentId: context.agentId,
      agentProfile: context.agentProfile,
      assetCommitId: context.assetCommitId,
      parentAssetCommitId: context.parentAssetCommitId,
      mountId: context.mountId,
      scoutRoot: context.scoutRoot,
      mountRoot: context.mountRoot,
      runRoot: context.runRoot,
      artifactRoot: context.artifactRoot,
      logsRoot: context.logsRoot,
      tempRoot: context.tempRoot,
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
      plugins: manifest.plugins,
      manifestPath: join(context.mountRoot, "mount-manifest.json"),
      resourceHash: context.resourceHash,
    };
  }

  /** Wipes/recreates the role mount, writes generated resources, and records a manifest. */
  materialize(options: MaterializeOptions): CodexMount {
    const context = this.context;
    const {
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
    } = context;
    const shellToolsRegistryHash = sha256File(join(assetsRoot, CodexAssetLayout.shellTools));
    if (
      options.persistedIdentity
      && options.persistedIdentity.resourceHash !== computedResourceHash
    ) {
      throw new Error(
        `Persisted resource identity does not match current assets for ${agentId}:`
        + ` persisted=${options.persistedIdentity.resourceHash}`
        + ` portable=${computedResourceHash}.`,
      );
    }
    const resourceHash = options.persistedIdentity?.resourceHash ?? computedResourceHash;

    ensureDir(runRoot);
    ensureDir(join(runRoot, "agents"));
    if (options.cleanRunRoot ?? true) recreateDir(agentRoot);
    else ensureDir(agentRoot);
    recreateDir(mountRoot);
    options.onMaterializationStep?.("wipe");
    ensureDir(artifactRoot);
    ensureDir(logsRoot);
    ensureDir(tempRoot);
    ensureDir(join(mountRoot, ".codex"));
    ensureDir(join(mountRoot, ".codex", "agents"));
    ensureDir(join(mountRoot, ".agents", "skills"));
    ensureDir(join(mountRoot, ".agents", "plugins"));
    ensureDir(join(mountRoot, ".scout", "skill"));
    ensureDir(join(mountRoot, "agents"));
    ensureDir(join(mountRoot, "plugins"));
    ensureDir(join(mountRoot, "bin"));
    ensureDir(join(mountRoot, "mcp"));

    const builtMcpServers = new McpServerBuilder({
      mountRoot,
      assetsRoot,
      tempRoot,
      dynamicValues: createMountMacroValues({
        scoutRoot,
        runRoot,
        mountRoot,
        artifactRoot,
        tempRoot,
        assetCommitId,
      }),
    }).build(profiledMcpServers);
    for (const builtServer of builtMcpServers) {
      writeTextFile(builtServer.server.wrapperPath, builtServer.wrapperContent);
      chmodSync(builtServer.server.wrapperPath, 0o755);
    }
    const materializedMcpServers = builtMcpServers.map(({ server }) => server);
    safeSymlink(join(assetsRoot, CodexAssetLayout.agentsMd), join(mountRoot, "AGENTS.md"));
    if (agentProfile.phases.includes(SynthesisPhase)) {
      safeSymlink(
        join(assetsRoot, CodexAssetLayout.coordinatorAgentsMd),
        join(mountRoot, "agents", "coordinator.AGENTS.md"),
      );
    } else {
      safeSymlink(
        join(assetsRoot, CodexAssetLayout.workerAgentsMd),
        join(mountRoot, "agents", "worker.AGENTS.md"),
      );
    }
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
    const materializedSkills = materializeSkills(
      assetsRoot,
      mountRoot,
      profiledSkillPaths,
      skillCatalog,
    );
    options.onMaterializationStep?.("skills");
    const pluginNames = materializePlugins(assetsRoot, mountRoot, profiledPluginPaths);
    options.onMaterializationStep?.("plugins");
    const shellBuild = new ShellToolBuilder(mountRoot, assetsRoot, tempRoot).build(profiledShellTools);
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
      shellToolsRegistryHash,
      workflowProfileAsset,
    });
    const mountManifest = manifestBuilder.build({
      assetCommitId,
      parentAssetCommitId,
      mountId,
      mountRoot,
      runtimeRoots: [
        { name: "mount", path: ".", access: "read" },
        { name: "artifacts", path: relativeOrSelf(mountRoot, artifactRoot), access: "read-write" },
        { name: "tmp", path: relativeOrSelf(mountRoot, tempRoot), access: "read-write" },
      ],
      issues: shellBuild.issues,
      resourceHash,
      mcpServers: materializedMcpServers,
      shellTools: shellBuild.tools.map(({ contract }) => contract),
      shellWrappers: shellBuild.tools.map(({ contract, wrapperPath }) => ({
        id: contract.id,
        wrapperPath,
      })),
      customAgentNames,
      materializedSkills,
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
      scoutRoot,
      mountRoot,
      runRoot,
      artifactRoot,
      logsRoot,
      tempRoot,
      issues: shellBuild.issues,
      readableRoots,
      writableRoots,
      shellTools: shellBuild.tools.map(({ contract }) => contract),
      mcpServers: materializedMcpServers,
      customAgents: customAgentNames,
      skills: materializedSkills,
      plugins: pluginNames,
      manifestPath,
      resourceHash,
    };
  }
}

/** Links selected Skill directories into the mount's Scout Skill namespace. */
function materializeSkills(
  assetsRoot: string,
  mountRoot: string,
  skillPaths: string[],
  catalog: ResolvedScoutSkillCatalogEntry[],
): MaterializedSkill[] {
  const pathsByName = new Map(
    skillPaths.map((skillPath) => [skillNameFromPath(skillPath), skillPath] as const),
  );
  return catalog.map((skill) => {
    const skillPath = pathsByName.get(skill.name);
    if (!skillPath) throw new Error(`Missing source path for Scout Skill ${skill.name}.`);
    const source = resolveAssetRelativePath(skillPath, assetsRoot);
    safeSymlink(resolve(source, ".."), join(mountRoot, dirname(skill.path)));
    return {
      name: skill.name,
      type: skill.type,
      ...(skill.domain ? { domain: skill.domain } : {}),
      description: skill.description,
      summary: skill.summary,
      ...(skill.phase ? { phase: [...skill.phase] } : {}),
      family: [...skill.family],
      requiredSkills: [...skill.resolvedRequiredSkills],
      optionalSkills: [...skill.resolvedOptionalSkills],
      requiredFamilyPaths: skill.requiredFamilyPaths.map((familyPath) => ({
        family: [...familyPath.family],
        wildcard: familyPath.wildcard,
      })),
      optionalFamilyPaths: skill.optionalFamilyPaths.map((familyPath) => ({
        family: [...familyPath.family],
        wildcard: familyPath.wildcard,
      })),
      path: skill.path,
    };
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

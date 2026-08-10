import {
  lstatSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sha256File } from "../../core/fs.js";
import { isPathWithin } from "../../core/path.js";
import type { MountManifest } from "../contracts/manifest.js";
import {
  resolveAssetLocalPath,
  resolveAssetRelativePath,
  skillNameFromPath,
} from "../files/asset-paths.js";
import type { MountContext } from "../contracts/mount-context.js";
import { runInspectionCheck } from "./diagnostics.js";
import { sameUnorderedStrings } from "./comparison.js";

/** Verifies mount directories, source presence, links, and link inventories. */
export class MountFilesystemInspector {
  constructor(
    private readonly context: MountContext,
    private readonly manifest: MountManifest,
  ) {}

  /** Runs filesystem checks in increasing cost order. */
  inspect(): string | undefined {
    return this.check("mount layout", this.context.mountRoot, () => this.checkLayout())
      ?? this.check("asset source", this.context.assetsRoot, () => this.checkAssetSources())
      ?? this.check("linked files", this.context.mountRoot, () => this.checkLinkedFiles())
      ?? this.check("Skill links", join(this.context.mountRoot, ".scout", "skills"), () => this.checkSkillLinks())
      ?? this.check("plugin links", join(this.context.mountRoot, "plugins"), () => this.checkPluginLinks());
  }

  private check(
    name: string,
    target: string,
    action: () => string | undefined,
  ): string | undefined {
    return runInspectionCheck(name, target, action);
  }

  private checkLayout(): string | undefined {
    const roots: Array<[string, string]> = [
      ["mount root", this.context.mountRoot],
      ["artifact root", this.context.artifactRoot],
      ["logs root", this.context.logsRoot],
    ];
    for (const [name, path] of roots) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return `${name} is not a directory: ${path}`;
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
    for (const relativePath of requiredDirs) {
      const path = join(this.context.mountRoot, relativePath);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return `mount directory is missing or invalid: ${relativePath}`;
      }
    }
    return undefined;
  }

  private checkAssetSources(): string | undefined {
    if (!Array.isArray(this.manifest.assets)) return "asset inventory is not an array";
    for (const asset of this.manifest.assets) {
      if (asset.id === "codex.shell_tools" && asset.type === "shell_tool_contract") continue;
      const source = resolveAssetLocalPath(asset.sourcePath, this.context.assetsRoot);
      if (!isPathWithin(this.context.assetsRoot, source)) {
        return `asset source escapes assets root: ${asset.sourcePath}`;
      }
      lstatSync(source);
    }
    return undefined;
  }

  private checkLinkedFiles(): string | undefined {
    if (!Array.isArray(this.manifest.linkedFiles)) return "linked file inventory is not an array";
    for (const linked of this.manifest.linkedFiles) {
      const target = resolve(this.context.mountRoot, linked.path);
      if (!isPathWithin(this.context.mountRoot, target)) {
        return `linked file path escapes mount root: ${linked.path}`;
      }
      const stat = lstatSync(target);
      if (!stat.isSymbolicLink()) return `linked file is not a symlink: ${linked.path}`;
      const expected = resolve(this.context.repoRoot, linked.sourcePath);
      if (!isPathWithin(this.context.assetsRoot, expected)) {
        return `linked source escapes assets root: ${linked.sourcePath}`;
      }
      const actualTarget = resolve(dirname(target), readlinkSync(target));
      if (actualTarget !== expected) return `link target changed: ${linked.path}`;
      if (sha256File(target) !== linked.hash) return `linked file content changed: ${linked.path}`;
    }
    return undefined;
  }

  private checkSkillLinks(): string | undefined {
    const expectedNames = this.context.profiledSkillPaths.map(skillNameFromPath);
    const directory = join(this.context.mountRoot, ".scout", "skills");
    if (!sameUnorderedStrings(readdirSync(directory), expectedNames)) {
      return "Skill link inventory changed";
    }
    for (const skillPath of this.context.profiledSkillPaths) {
      const name = skillNameFromPath(skillPath);
      const linkPath = join(directory, name);
      const expectedTarget = resolveAssetRelativePath(dirname(skillPath), this.context.assetsRoot);
      if (!isCurrentSymlink(linkPath, expectedTarget)) return `Skill link changed: ${name}`;
    }
    return undefined;
  }

  private checkPluginLinks(): string | undefined {
    const expectedNames = this.context.profiledPluginPaths.map((path) => basename(path));
    const directory = join(this.context.mountRoot, "plugins");
    if (!sameUnorderedStrings(readdirSync(directory), expectedNames)) {
      return "plugin link inventory changed";
    }
    for (const pluginPath of this.context.profiledPluginPaths) {
      const name = basename(pluginPath);
      const linkPath = join(directory, name);
      const expectedTarget = resolveAssetRelativePath(pluginPath, this.context.assetsRoot);
      if (!isCurrentSymlink(linkPath, expectedTarget)) return `plugin link changed: ${name}`;
    }
    return undefined;
  }
}

function isCurrentSymlink(path: string, expectedTarget: string): boolean {
  return lstatSync(path).isSymbolicLink()
    && resolve(dirname(path), readlinkSync(path)) === expectedTarget;
}

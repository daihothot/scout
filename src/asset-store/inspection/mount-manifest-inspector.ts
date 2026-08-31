import { basename, join } from "node:path";
import type { MountManifest } from "../contracts/manifest.js";
import { CodexAssetLayout } from "../assets/asset-layout.js";
import { SynthesisPhase } from "../../core/workflow/index.js";
import {
  assetSourcePath,
  customAgentNameFromPath,
  relativeOrSelf,
} from "../files/asset-paths.js";
import type { MountContext } from "../contracts/mount-context.js";
import {
  sameUnorderedStrings,
  sameValue,
} from "./comparison.js";

/** Verifies the persisted manifest's logical inventories before filesystem I/O. */
export class MountManifestInspector {
  constructor(
    private readonly context: MountContext,
    private readonly manifest: MountManifest,
  ) {}

  /** Returns the first contract or inventory mismatch. */
  inspect(): string | undefined {
    const manifest = this.manifest;
    const context = this.context;
    if (!Array.isArray(manifest.issues)) return "materialization issue inventory is not an array";
    const fatalIssue = manifest.issues.find((issue) => issue.severity === "error");
    if (fatalIssue) {
      return `mount contains materialization error: ${fatalIssue.code}`
        + ` (${fatalIssue.resourceId}): ${fatalIssue.message}`;
    }
    if (!Array.isArray(manifest.customAgents)
      || !sameUnorderedStrings(
        manifest.customAgents,
        context.profiledCustomAgentPaths.map(customAgentNameFromPath),
      )) {
      return "custom agent inventory changed";
    }
    if (!Array.isArray(manifest.skills)
      || !sameValue(
        manifest.skills,
        context.skillCatalog.map((skill) => ({
          name: skill.name,
          type: skill.type,
          description: skill.description,
          summary: skill.summary,
          ...(skill.phase ? { phase: [...skill.phase] } : {}),
          family: [...skill.family],
          requiredSkills: [...skill.requiredSkills],
          optionalSkills: [...skill.optionalSkills],
          path: skill.path,
        })),
      )) {
      return "Skill inventory changed";
    }
    const expectedRuntimeRoots = [
      { name: "mount", path: ".", access: "read" },
      {
        name: "artifacts",
        path: relativeOrSelf(context.mountRoot, context.artifactRoot),
        access: "read-write",
      },
      {
        name: "tmp",
        path: relativeOrSelf(context.mountRoot, context.tempRoot),
        access: "read-write",
      },
    ];
    if (!Array.isArray(manifest.runtimeRoots)
      || !sameValue(manifest.runtimeRoots, expectedRuntimeRoots)) {
      return "Runtime root inventory changed";
    }
    if (!Array.isArray(manifest.plugins)
      || !sameUnorderedStrings(
        manifest.plugins,
        context.profiledPluginPaths.map((path) => basename(path)),
      )) {
      return "plugin inventory changed";
    }
    const linkedIssue = this.checkLinkedInventory();
    if (linkedIssue) return linkedIssue;
    return undefined;
  }

  private checkLinkedInventory(): string | undefined {
    if (!Array.isArray(this.manifest.linkedFiles)) return "linked file inventory is not an array";
    const expected = new Map<string, string>([
      ["AGENTS.md", assetSourcePath(CodexAssetLayout.agentsMd)],
      ...(this.context.agentProfile.phases.includes(SynthesisPhase)
        ? []
        : [[
          join("agents", "worker.AGENTS.md"),
          assetSourcePath(CodexAssetLayout.workerAgentsMd),
        ]] as Array<[string, string]>),
      ...this.context.profiledCustomAgentPaths.map((path) => [
        join(".codex", "agents", customAgentNameFromPath(path) + ".toml"),
        assetSourcePath(path),
      ] as [string, string]),
    ]);
    if (!sameUnorderedStrings(
      this.manifest.linkedFiles.map((file) => file.path),
      [...expected.keys()],
    )) {
      return "linked file inventory changed";
    }
    for (const file of this.manifest.linkedFiles) {
      if (expected.get(file.path) !== file.sourcePath) {
        return `linked file source changed: ${file.path}`;
      }
    }
    return undefined;
  }
}

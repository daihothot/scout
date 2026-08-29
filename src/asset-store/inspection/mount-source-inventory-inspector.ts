import { sha256File } from "../../core/fs.js";
import type { MountManifest } from "../contracts/manifest.js";
import { CodexAssetLayout } from "../assets/asset-layout.js";
import {
  resolveAssetRelativePath,
} from "../files/asset-paths.js";
import type { MountContext } from "../contracts/mount-context.js";
import { MountManifestBuilder } from "../builders/mount-manifest-builder.js";
import { runInspectionCheck } from "./diagnostics.js";

/** Compares the portable source-resource inventory with the current assets. */
export class MountSourceInventoryInspector {
  constructor(
    private readonly context: MountContext,
    private readonly manifest: MountManifest,
  ) {}

  /** Rebuilds the expected inventory once and reports the first changed resource. */
  inspect(): string | undefined {
    return runInspectionCheck(
      "source inventory verification",
      this.context.assetsRoot,
      () => {
        const expected = this.buildExpectedInventory();
        const actual = this.manifest.assets;
        if (!Array.isArray(actual)) return "asset inventory is not an array";
        if (actual.length !== expected.length) {
          return `asset inventory count changed: persisted=${actual.length} current=${expected.length}`;
        }

        const actualById = new Map<string, MountManifest["assets"][number]>();
        for (const asset of actual) {
          if (actualById.has(asset.id)) return `duplicate asset id: ${asset.id}`;
          actualById.set(asset.id, asset);
        }
        for (const expectedAsset of expected) {
          const actualAsset = actualById.get(expectedAsset.id);
          if (!actualAsset) return `asset missing from manifest: ${expectedAsset.id}`;
          if (actualAsset.type !== expectedAsset.type) {
            return `asset type changed: ${expectedAsset.id}`;
          }
          if (actualAsset.sourcePath !== expectedAsset.sourcePath) {
            return `asset source changed: ${expectedAsset.id}`;
          }
          // Device-owned tool registries and the graph source are provenance,
          // not effective mount resources. Their selected projections are
          // validated through the concrete tool and Agent Profile entries.
          if (expectedAsset.id !== "codex.shell_tools"
            && expectedAsset.type !== "workflow_profile"
            && actualAsset.hash !== expectedAsset.hash) {
            return `asset hash changed: ${expectedAsset.id}`;
          }
        }
        return undefined;
      },
    );
  }

  private buildExpectedInventory(): MountManifest["assets"] {
    const context = this.context;
    return new MountManifestBuilder({
      agentId: context.agentId,
      agentProfile: context.agentProfile,
      assetsRoot: context.assetsRoot,
      mcpServerContracts: context.profiledMcpServers,
      shellToolContracts: context.profiledShellTools,
      customAgentPaths: context.profiledCustomAgentPaths,
      skillPaths: context.profiledSkillPaths,
      pluginPaths: context.profiledPluginPaths,
      workflowProfileAsset: context.workflowProfileAsset,
      shellToolsRegistryHash: sha256File(
        resolveAssetRelativePath(CodexAssetLayout.shellTools, context.assetsRoot),
      ),
    }).buildAssetInventory();
  }
}

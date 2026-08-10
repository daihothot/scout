import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServerBuilder } from "../builders/mcp-server-builder.js";
import { MountGeneratedFilesBuilder } from "../builders/mount-generated-files-builder.js";
import { ShellToolBuilder } from "../builders/shell-tool-builder.js";
import type {
  MountManifest,
} from "../contracts/manifest.js";
import type { MountPreparationInspection } from "../contracts/materialization.js";
import type { PersistedMountIdentity } from "../contracts/identity.js";
import type { MountContext } from "../contracts/mount-context.js";
import { buildMountMacroValues } from "../mount/macros.js";
import { MountGeneratedFilesInspector } from "./mount-generated-files-inspector.js";
import { MountIdentityInspector } from "./mount-identity-inspector.js";
import { MountManifestInspector } from "./mount-manifest-inspector.js";
import { MountMcpServersInspector } from "./mount-mcp-servers-inspector.js";
import { MountFilesystemInspector } from "./mount-filesystem-inspector.js";
import { MountShellToolsInspector } from "./mount-shell-tools-inspector.js";
import { MountSourceInventoryInspector } from "./mount-source-inventory-inspector.js";
import { runInspectionCheck } from "./diagnostics.js";

interface MountReuseInspection {
  reusable: boolean;
  reason?: string;
}

/**
 * Orders the independent mount inspection capabilities and preserves the
 * fail-closed rule for changed portable resources.
 */
export class MountInspector {
  constructor(
    private readonly context: MountContext,
    private readonly existingManifest: MountManifest | undefined,
    private readonly persistedIdentity?: PersistedMountIdentity,
    private readonly allowLegacyResourceIdentityMigration = false,
  ) {}

  /** Returns a reuse/rebuild decision and the first actionable mismatch. */
  inspect(): MountPreparationInspection {
    const reusable = this.existingManifest
      ? this.inspectExistingMount(this.existingManifest)
      : { reusable: false, reason: "mount manifest is missing" };
    if (
      this.existingManifest
      && !reusable.reusable
      && this.existingManifest.resourceInventoryVersion === 1
      && !this.allowLegacyResourceIdentityMigration
      && (this.persistedIdentity?.resourceHash ?? this.existingManifest.resourceHash)
        !== this.context.resourceHash
    ) {
      const sourceReason = runInspectionCheck(
        "mount source inventory verification",
        this.context.assetsRoot,
        () => new MountSourceInventoryInspector(
          this.context,
          this.existingManifest!,
        ).inspect(),
      );
      throw new Error(
        `Persisted asset changed for ${this.context.agentId}: resource inventory`
        + (sourceReason ?? reusable.reason ? `; ${sourceReason ?? reusable.reason}` : ""),
      );
    }
    return {
      decision: reusable.reusable ? "reused" : "rebuild",
      reason: reusable.reason,
    };
  }

  private inspectExistingMount(manifest: MountManifest): MountReuseInspection {
    const mountChecks = [
      {
        name: "mount identity verification",
        target: join(this.context.mountRoot, "mount-manifest.json"),
        inspector: new MountIdentityInspector(
          this.context,
          manifest,
          this.persistedIdentity,
          this.allowLegacyResourceIdentityMigration,
        ),
      },
      {
        name: "mount manifest verification",
        target: join(this.context.mountRoot, "mount-manifest.json"),
        inspector: new MountManifestInspector(this.context, manifest),
      },
      {
        name: "mount filesystem verification",
        target: this.context.mountRoot,
        inspector: new MountFilesystemInspector(this.context, manifest),
      },
    ];
    for (const check of mountChecks) {
      const reason = runInspectionCheck(
        check.name,
        check.target,
        () => check.inspector.inspect(),
      );
      if (reason) return { reusable: false, reason };
    }

    const runtimeReason = runInspectionCheck(
      "runtime expectation construction",
      this.context.mountRoot,
      () => this.inspectRuntime(manifest),
    );
    if (runtimeReason) return { reusable: false, reason: runtimeReason };

    const sourceReason = runInspectionCheck(
      "mount source inventory verification",
      this.context.assetsRoot,
      () => new MountSourceInventoryInspector(this.context, manifest).inspect(),
    );
    if (sourceReason) return { reusable: false, reason: sourceReason };
    return { reusable: true };
  }

  private inspectRuntime(manifest: MountManifest): string | undefined {
    const shellTools = new ShellToolBuilder(
      this.context.mountRoot,
      this.context.assetsRoot,
    ).build(this.context.profiledShellTools).tools;
    const mcpServers = new McpServerBuilder({
      mountRoot: this.context.mountRoot,
      assetsRoot: this.context.assetsRoot,
      dynamicValues: buildMountMacroValues({
        repoRoot: this.context.repoRoot,
        runRoot: this.context.runRoot,
        mountRoot: this.context.mountRoot,
        artifactRoot: this.context.artifactRoot,
        assetCommitId: this.context.assetCommitId,
        runId: this.context.runId,
      }),
    }).build(this.context.profiledMcpServers);
    const generatedFiles = new MountGeneratedFilesBuilder(
      this.context,
      readFileSync(
        join(this.context.assetsRoot, this.context.agentProfile.config),
        "utf8",
      ),
      mcpServers.map(({ server }) => server),
    ).build();
    const checks: Array<{
      name: string;
      target: string;
      inspector: { inspect(): string | undefined };
    }> = [
      {
        name: "generated runtime files",
        target: this.context.mountRoot,
        inspector: new MountGeneratedFilesInspector(
          this.context,
          manifest,
          generatedFiles,
          shellTools,
          mcpServers,
        ),
      },
      {
        name: "shell tool contract",
        target: join(this.context.mountRoot, "bin"),
        inspector: new MountShellToolsInspector(this.context, manifest, shellTools),
      },
      {
        name: "MCP contract",
        target: join(this.context.mountRoot, "mcp"),
        inspector: new MountMcpServersInspector(this.context, manifest, mcpServers),
      },
    ];
    for (const check of checks) {
      const reason = runInspectionCheck(
        check.name,
        check.target,
        () => check.inspector.inspect(),
      );
      if (reason) return reason;
    }
    return undefined;
  }
}

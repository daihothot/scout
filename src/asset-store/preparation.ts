import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { sha256Text, stableJson } from "../core/fs.js";
import { MountContextBuilder } from "./builders/mount-context-builder.js";
import type { MountManifest } from "./contracts/manifest.js";
import type {
  MaterializeOptions,
  MountPreparationInspection,
  MountPreparationResult,
} from "./contracts/materialization.js";
import type { MountContext } from "./contracts/mount-context.js";
import {
  readMountManifestFile,
  type MountManifestFileReadResult,
} from "./files/mount-manifest-file.js";
import { MountInspector } from "./inspection/mount-inspector.js";
import { MountMaterializer } from "./mount/materializer.js";

interface CachedMountInspection {
  context: MountContext;
  existingManifest?: MountManifest;
  inspection: MountPreparationInspection;
  optionsFingerprint: string;
  persistedManifestFingerprint: string;
  manifestFileFingerprint: string;
  runtimeBindingFingerprint: string;
  assetsLinkFingerprint: string;
  assetsFingerprint: string;
  mountFingerprint: string;
  artifactFingerprint: string;
  logsFingerprint: string;
}

/**
 * Keeps the two-stage inspect/prepare handoff explicit without making the
 * materializer responsible for lifecycle coordination.
 */
export class MountPreparation {
  private readonly inspectedMountContexts = new WeakMap<MaterializeOptions, CachedMountInspection>();

  /** Reuses a cached inspection when inputs are unchanged, otherwise materializes the role mount. */
  prepare(
    options: MaterializeOptions & { persistedManifest?: MountManifest },
    observeMaterializationStep?: MaterializeOptions["onMaterializationStep"],
  ): MountPreparationResult {
    const cached = this.inspectedMountContexts.get(options);
    this.inspectedMountContexts.delete(options);
    let context: MountContext;
    let existingManifest: MountManifest | undefined;
    let inspection: MountPreparationInspection;
    const optionsFingerprint = materializeOptionsFingerprint(options);
    const persistedManifestFingerprint = mountManifestFingerprint(options.persistedManifest);
    if (!cached || cached.optionsFingerprint !== optionsFingerprint
      || cached.persistedManifestFingerprint !== persistedManifestFingerprint) {
      context = new MountContextBuilder(options).build();
      ({ existingManifest, inspection } = inspectMountState(context, options));
    } else if (captureAssetsLinkFingerprint(cached.context.scoutRoot)
      !== cached.assetsLinkFingerprint
      || capturePathFingerprint(cached.context.assetsRoot) !== cached.assetsFingerprint) {
      context = new MountContextBuilder(options).build();
      ({ existingManifest, inspection } = inspectMountState(context, options));
    } else {
      context = cached.context;
      const manifestFile = readMountManifestFile(context.mountRoot);
      if (mountManifestFileFingerprint(manifestFile) !== cached.manifestFileFingerprint
        || runtimeBindingFingerprint(context) !== cached.runtimeBindingFingerprint
        || capturePathFingerprint(context.mountRoot) !== cached.mountFingerprint
        || captureRootFingerprint(context.artifactRoot) !== cached.artifactFingerprint
        || captureRootFingerprint(context.logsRoot) !== cached.logsFingerprint) {
        ({ existingManifest, inspection } = inspectMountState(context, options, manifestFile));
      } else {
        existingManifest = cached.existingManifest;
        inspection = cached.inspection;
      }
    }
    if (inspection.decision === "reused") {
      options.onPreparationDecision?.("reused");
      return {
        mount: new MountMaterializer(context).buildReusableMount(existingManifest!),
        decision: "reused",
      };
    }
    options.onPreparationDecision?.("rebuild", inspection.reason);
    const materializeOptions = options.runId && !observeMaterializationStep
      ? options
      : {
        ...options,
        runId: options.runId ?? context.runId,
        ...(observeMaterializationStep
          ? {
            onMaterializationStep: (step: Parameters<NonNullable<MaterializeOptions["onMaterializationStep"]>>[0]) => {
              observeMaterializationStep(step);
              options.onMaterializationStep?.(step);
            },
          }
          : {}),
      };
    return {
      mount: new MountMaterializer(context).materialize(materializeOptions),
      decision: "rebuild",
      reason: inspection.reason,
    };
  }

  /** Performs and caches the non-mutating mount reuse inspection for one options object. */
  inspect(
    options: MaterializeOptions & { persistedManifest?: MountManifest },
  ): MountPreparationInspection {
    const context = new MountContextBuilder(options).build();
    const manifestFile = readMountManifestFile(context.mountRoot);
    const { existingManifest, inspection } = inspectMountState(context, options, manifestFile);
    this.inspectedMountContexts.set(options, {
      context,
      existingManifest,
      inspection,
      optionsFingerprint: materializeOptionsFingerprint(options),
      persistedManifestFingerprint: mountManifestFingerprint(options.persistedManifest),
      manifestFileFingerprint: mountManifestFileFingerprint(manifestFile),
      runtimeBindingFingerprint: runtimeBindingFingerprint(context),
      assetsLinkFingerprint: captureAssetsLinkFingerprint(context.scoutRoot),
      assetsFingerprint: capturePathFingerprint(context.assetsRoot),
      mountFingerprint: capturePathFingerprint(context.mountRoot),
      artifactFingerprint: captureRootFingerprint(context.artifactRoot),
      logsFingerprint: captureRootFingerprint(context.logsRoot),
    });
    return inspection;
  }
}

function materializeOptionsFingerprint(options: MaterializeOptions): string {
  return stableJson({
    scoutRoot: resolve(options.scoutRoot),
    runId: options.runId,
    agentId: options.agentId,
    parentAssetCommitId: options.parentAssetCommitId,
    persistedIdentity: options.persistedIdentity,
    allowLegacyResourceIdentityMigration: options.allowLegacyResourceIdentityMigration,
    cleanRunRoot: options.cleanRunRoot,
  });
}

function mountManifestFingerprint(manifest: MountManifest | undefined): string {
  return manifest ? stableJson(manifest) : "";
}

function inspectMountState(
  context: MountContext,
  options: MaterializeOptions,
  manifestFile = readMountManifestFile(context.mountRoot),
): {
  existingManifest?: MountManifest;
  inspection: MountPreparationInspection;
} {
  if (manifestFile.status === "absent") {
    return {
      inspection: {
        decision: "rebuild",
        reason: `mount manifest is missing: ${manifestFile.path}`,
      },
    };
  }
  if (manifestFile.status === "invalid") {
    return {
      inspection: {
        decision: "rebuild",
        reason: `mount manifest is invalid at ${manifestFile.path}: ${manifestFile.reason}`,
      },
    };
  }
  return {
    existingManifest: manifestFile.manifest,
    inspection: new MountInspector(
      context,
      manifestFile.manifest,
      options.persistedIdentity,
      options.allowLegacyResourceIdentityMigration,
    ).inspect(),
  };
}

function mountManifestFileFingerprint(result: MountManifestFileReadResult): string {
  switch (result.status) {
    case "present":
      return stableJson({ status: result.status, manifest: result.manifest });
    case "absent":
      return stableJson({ status: result.status });
    case "invalid":
      return stableJson({ status: result.status, reason: result.reason });
  }
}

/** Captures the current device paths rendered into shell and MCP wrappers. */
function runtimeBindingFingerprint(context: MountContext): string {
  return sha256Text(stableJson({
    cwd: process.cwd(),
    execPath: process.execPath,
    path: process.env.PATH ?? "",
    mountRoot: context.mountRoot,
  }));
}

/** Captures only the root identity consumed by mount layout inspection. */
function captureRootFingerprint(root: string): string {
  try {
    const stat = lstatSync(root);
    return sha256Text(stableJson({
      kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "other",
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      changedAt: stat.ctimeMs,
      target: stat.isSymbolicLink() ? readlinkSync(root) : undefined,
    }));
  } catch (error) {
    return sha256Text(stableJson({
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/** Captures the ScoutRoot assets entry and its resolved target without walking it. */
function captureAssetsLinkFingerprint(scoutRoot: string): string {
  const path = join(scoutRoot, "assets");
  try {
    const stat = lstatSync(path);
    return sha256Text(stableJson({
      kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "other",
      target: stat.isSymbolicLink() ? readlinkSync(path) : undefined,
      resolvedTarget: realpathSync(path),
      device: stat.dev,
      inode: stat.ino,
      modifiedAt: stat.mtimeMs,
      changedAt: stat.ctimeMs,
    }));
  } catch (error) {
    return sha256Text(stableJson({
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * Captures metadata only. The inspection pass still owns content hashes; this
 * check only detects ordinary writes between inspect and prepare.
 */
function capturePathFingerprint(root: string): string {
  const entries: string[] = [];
  const visit = (path: string, relativePath: string): void => {
    try {
      const stat = lstatSync(path);
      const kind = stat.isSymbolicLink()
        ? "link"
        : stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : "other";
      const target = stat.isSymbolicLink() ? readlinkSync(path) : "";
      entries.push([
        relativePath,
        kind,
        stat.size,
        stat.mtimeMs,
        stat.ctimeMs,
        stat.mode,
        stat.ino,
        target,
      ].join("\u0000"));
      if (kind !== "directory") return;
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relativePath ? join(relativePath, name) : name);
      }
    } catch {
      entries.push([relativePath, "missing"].join("\u0000"));
    }
  };
  visit(root, "");
  return sha256Text(entries.sort().join("\n"));
}

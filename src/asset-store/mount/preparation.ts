import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Text } from "../../core/fs.js";
import type {
  MountManifest,
  MountPreparationInspection,
  MountPreparationResult,
} from "../types.js";
import {
  MountContextBuilder,
  type MaterializeOptions,
  type MountContext,
} from "./context-builder.js";
import { readExistingMountManifest } from "./manifest-builder.js";
import { MountInspector } from "./inspector.js";
import {
  MountMaterializer,
} from "./materializer.js";

interface CachedMountInspection {
  context: MountContext;
  existingManifest?: MountManifest;
  inspection: MountPreparationInspection;
  optionsFingerprint: string;
  manifestFingerprint: string;
  assetsFingerprint: string;
  mountFingerprint: string;
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
  ): MountPreparationResult {
    const cached = this.inspectedMountContexts.get(options);
    this.inspectedMountContexts.delete(options);
    let context: MountContext;
    let existingManifest: MountManifest | undefined;
    let inspection: MountPreparationInspection;
    const optionsFingerprint = materializeOptionsFingerprint(options);
    const manifestFingerprint = mountManifestFingerprint(options.persistedManifest);
    if (!cached || cached.optionsFingerprint !== optionsFingerprint
      || cached.manifestFingerprint !== manifestFingerprint
      || capturePathFingerprint(cached.context.assetsRoot) !== cached.assetsFingerprint) {
      context = new MountContextBuilder(options).build();
      existingManifest = options.persistedManifest ?? readExistingMountManifest(context.mountRoot);
      inspection = new MountInspector(context, existingManifest, options.persistedIdentity).inspect();
    } else if (capturePathFingerprint(cached.context.mountRoot) !== cached.mountFingerprint) {
      context = cached.context;
      existingManifest = options.persistedManifest ?? readExistingMountManifest(context.mountRoot);
      inspection = new MountInspector(context, existingManifest, options.persistedIdentity).inspect();
    } else {
      context = cached.context;
      existingManifest = cached.existingManifest;
      inspection = cached.inspection;
    }
    if (inspection.decision === "reused") {
      options.onPreparationDecision?.("reused");
      return {
        mount: new MountMaterializer(context).buildReusableMount(existingManifest!),
        decision: "reused",
      };
    }
    options.onPreparationDecision?.("rebuild", inspection.reason);
    const materializeOptions = options.runId ? options : { ...options, runId: context.runId };
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
    const existingManifest = options.persistedManifest ?? readExistingMountManifest(context.mountRoot);
    const inspection = new MountInspector(context, existingManifest, options.persistedIdentity).inspect();
    this.inspectedMountContexts.set(options, {
      context,
      existingManifest,
      inspection,
      optionsFingerprint: materializeOptionsFingerprint(options),
      manifestFingerprint: mountManifestFingerprint(options.persistedManifest),
      assetsFingerprint: capturePathFingerprint(context.assetsRoot),
      mountFingerprint: capturePathFingerprint(context.mountRoot),
    });
    return inspection;
  }
}

function materializeOptionsFingerprint(options: MaterializeOptions): string {
  return JSON.stringify({
    repoRoot: resolve(options.repoRoot),
    runId: options.runId,
    agentId: options.agentId,
    parentAssetCommitId: options.parentAssetCommitId,
    persistedIdentity: options.persistedIdentity,
    cleanRunRoot: options.cleanRunRoot,
  });
}

function mountManifestFingerprint(manifest: MountManifest | undefined): string {
  return manifest ? JSON.stringify(manifest) : "";
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

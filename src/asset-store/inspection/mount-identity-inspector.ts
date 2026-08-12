import type { PersistedMountIdentity } from "../contracts/identity.js";
import type { MountManifest } from "../contracts/manifest.js";
import {
  relativeOrSelf,
} from "../files/asset-paths.js";
import type { MountContext } from "../contracts/mount-context.js";
import {
  sameAgentProfile,
  sameUnorderedStrings,
} from "./comparison.js";

/** Verifies portable identity and profile-owned permission roots. */
export class MountIdentityInspector {
  constructor(
    private readonly context: MountContext,
    private readonly manifest: MountManifest,
    private readonly persistedIdentity?: PersistedMountIdentity,
    private readonly allowLegacyResourceIdentityMigration = false,
  ) {}

  /** Returns the first identity mismatch, preserving the field that changed. */
  inspect(): string | undefined {
    const manifest = this.manifest;
    const context = this.context;
    if (manifest.resourceInventoryVersion !== 1) return "legacy mount manifest";
    if (manifest.mountRoot !== ".") return "mount manifest is not portable: mountRoot must be .";
    if (manifest.agentId !== context.agentId) {
      return `agent id changed: persisted=${manifest.agentId} current=${context.agentId}`;
    }
    if (manifest.mountId !== context.mountId) {
      return `mount id changed: persisted=${manifest.mountId} current=${context.mountId}`;
    }
    if (manifest.assetCommitId !== context.assetCommitId) {
      return `asset commit changed: persisted=${manifest.assetCommitId} current=${context.assetCommitId}`;
    }
    if (manifest.parentAssetCommitId !== context.parentAssetCommitId) {
      return "parent asset commit changed";
    }
    if (manifest.resourceHash !== context.resourceHash) {
      return `resource hash changed: persisted=${manifest.resourceHash} current=${context.resourceHash}`;
    }
    if (!sameAgentProfile(manifest.agentProfile, context.agentProfile)) {
      return "agent profile changed";
    }

    const readableRoots = context.readableRoots.map((root) =>
      relativeOrSelf(context.mountRoot, root)
    );
    if (!Array.isArray(manifest.readableRoots)
      || !sameUnorderedStrings(manifest.readableRoots, readableRoots)) {
      return "readable roots changed";
    }
    const writableRoots = context.writableRoots.map((root) => relativeOrSelf(context.mountRoot, root));
    if (!sameUnorderedStrings(manifest.writableRoots, writableRoots)) {
      return "writable roots changed";
    }

    if (this.persistedIdentity
      && this.persistedIdentity.resourceHash !== context.resourceHash
      && !this.allowLegacyResourceIdentityMigration) {
      return `persisted resource hash changed: persisted=${this.persistedIdentity.resourceHash}`
        + ` current=${context.resourceHash}`;
    }
    return undefined;
  }
}

import type { PersistedMountIdentity } from "../contracts/identity.js";
import type { MountManifest } from "../contracts/manifest.js";
import type { MountContext } from "../contracts/mount-context.js";
import {
  sameAgentProfileResources,
  sameUnorderedStrings,
} from "./comparison.js";

/** Verifies portable identity and profile-owned permission roots. */
export class MountIdentityInspector {
  constructor(
    private readonly context: MountContext,
    private readonly manifest: MountManifest,
    private readonly persistedIdentity?: PersistedMountIdentity,
  ) {}

  /** Returns the first identity mismatch, preserving the field that changed. */
  inspect(): string | undefined {
    const manifest = this.manifest;
    const context = this.context;
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
    if (!sameAgentProfileResources(manifest.agentProfile, context.agentProfile)) {
      return "agent profile changed";
    }

    if (!Array.isArray(manifest.profileReadableRoots)
      || !sameUnorderedStrings(
        manifest.profileReadableRoots,
        context.agentProfile.readableRoots ?? [],
      )) {
      return "profile readable roots changed";
    }
    if (!Array.isArray(manifest.profileWritableRoots)
      || !sameUnorderedStrings(
        manifest.profileWritableRoots,
        context.agentProfile.writableRoots ?? [],
      )) {
      return "profile writable roots changed";
    }

    if (this.persistedIdentity
      && this.persistedIdentity.resourceHash !== context.resourceHash) {
      return `persisted resource hash changed: persisted=${this.persistedIdentity.resourceHash}`
        + ` current=${context.resourceHash}`;
    }
    return undefined;
  }
}

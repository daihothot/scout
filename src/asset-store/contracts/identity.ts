/**
 * Persisted mount identity supplied by a run when reconstructing one role.
 * Identity generation and comparison remain builder/inspection responsibilities.
 */

/** Stable identity facts preserved when an existing run mount is reconstructed. */
export interface PersistedMountIdentity {
  assetCommitId: string;
  parentAssetCommitId: string | undefined;
  mountId: string;
  resourceHash: string;
}

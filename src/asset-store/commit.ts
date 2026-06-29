import type { AssetCommit, CodexMount } from "./types.js";

export interface BuildAssetCommitOptions {
  mount: CodexMount;
  preflightStatus: "passed" | "failed";
  preflightPath: string;
}

export function buildAssetCommit(options: BuildAssetCommitOptions): AssetCommit {
  return {
    agentId: options.mount.agentId,
    agentProfile: options.mount.agentProfile,
    assetCommitId: options.mount.assetCommitId,
    parentAssetCommitId: options.mount.parentAssetCommitId,
    mountId: options.mount.mountId,
    mountRoot: options.mount.mountRoot,
    runRoot: options.mount.runRoot,
    artifactRoot: options.mount.artifactRoot,
    logsRoot: options.mount.logsRoot,
    issues: options.mount.issues,
    trustedRoots: options.mount.trustedRoots,
    writableRoots: options.mount.writableRoots,
    mcpServerBindings: options.mount.mcpServerBindings,
    shellTools: options.mount.shellTools,
    mcpServers: options.mount.mcpServers,
    skills: options.mount.skills,
    plugins: options.mount.plugins,
    manifestPath: options.mount.manifestPath,
    resourceHash: options.mount.resourceHash,
    createdAt: new Date().toISOString(),
    status: options.preflightStatus === "passed" ? "preflight_passed" : "preflight_failed",
    preflightRef: options.preflightPath,
  };
}

export const MountMacros = {
  RepoRoot: "SCOUT_REPO_ROOT",
  RunRoot: "SCOUT_RUN_ROOT",
  MountRoot: "SCOUT_MOUNT_ROOT",
  ArtifactRoot: "SCOUT_ARTIFACT_ROOT",
  AssetCommitId: "SCOUT_ASSET_COMMIT_ID",
  RunId: "SCOUT_RUN_ID",
} as const;

export type MountMacro = typeof MountMacros[keyof typeof MountMacros];

export interface MountMacroValuesInput {
  repoRoot: string;
  runRoot: string;
  mountRoot: string;
  artifactRoot: string;
  assetCommitId: string;
  runId?: string;
}

export type MountMacroValues = Record<MountMacro, string | undefined>;

export interface MountShellEnvironmentInput {
  runRoot?: string;
  artifactRoot: string;
  assetCommitId: string;
  runId?: string;
}

export function buildMountMacroValues(input: MountMacroValuesInput): MountMacroValues {
  return {
    [MountMacros.RepoRoot]: input.repoRoot,
    [MountMacros.RunRoot]: input.runRoot,
    [MountMacros.MountRoot]: input.mountRoot,
    [MountMacros.ArtifactRoot]: input.artifactRoot,
    [MountMacros.AssetCommitId]: input.assetCommitId,
    [MountMacros.RunId]: input.runId ?? runIdFromRunRoot(input.runRoot),
  };
}

export function resolveMountMacros(
  value: string,
  values: Record<string, string | undefined>,
): string {
  return value.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (_match, key: string) => values[key] ?? "");
}

export function buildMountShellEnvironment(input: MountShellEnvironmentInput): Record<string, string> {
  return {
    [MountMacros.RunId]: input.runId ?? (input.runRoot ? runIdFromRunRoot(input.runRoot) : ""),
    [MountMacros.ArtifactRoot]: input.artifactRoot,
    [MountMacros.AssetCommitId]: input.assetCommitId,
  };
}

function runIdFromRunRoot(runRoot: string): string {
  return runRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

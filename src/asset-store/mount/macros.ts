/** Runtime placeholders expanded only after the run and mount roots exist. */
export const MountMacros = {
  ScoutRoot: "SCOUT_ROOT",
  RunRoot: "SCOUT_RUN_ROOT",
  MountRoot: "SCOUT_MOUNT_ROOT",
  ArtifactRoot: "SCOUT_ARTIFACT_ROOT",
  AssetCommitId: "SCOUT_ASSET_COMMIT_ID",
  RunId: "SCOUT_RUN_ID",
} as const;

/** Union of placeholder names accepted by mount configuration expansion. */
export type MountMacro = typeof MountMacros[keyof typeof MountMacros];

/** Repository/run paths and identity values available during expansion. */
export interface MountMacroValuesInput {
  scoutRoot: string;
  runRoot: string;
  mountRoot: string;
  artifactRoot: string;
  assetCommitId: string;
  runId?: string;
}

/** Complete macro map passed to config, MCP, and shell-tool materializers. */
export type MountMacroValues = Record<MountMacro, string | undefined>;

/** Values exported into a shell process; Scout root is intentionally omitted. */
export interface MountShellEnvironmentInput {
  runRoot: string;
  artifactRoot: string;
  assetCommitId: string;
  runId?: string;
}

/** Creates the full placeholder map, deriving the run id when omitted. */
export function buildMountMacroValues(input: MountMacroValuesInput): MountMacroValues {
  return {
    [MountMacros.ScoutRoot]: input.scoutRoot,
    [MountMacros.RunRoot]: input.runRoot,
    [MountMacros.MountRoot]: input.mountRoot,
    [MountMacros.ArtifactRoot]: input.artifactRoot,
    [MountMacros.AssetCommitId]: input.assetCommitId,
    [MountMacros.RunId]: input.runId ?? runIdFromRunRoot(input.runRoot),
  };
}

/** Replaces known `${...}` placeholders and removes unresolved values. */
export function resolveMountMacros(
  value: string,
  values: Record<string, string | undefined>,
): string {
  return value.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (_match, key: string) => values[key] ?? "");
}

/** Produces the environment variables exposed to shell and MCP commands. */
export function buildMountShellEnvironment(input: MountShellEnvironmentInput): Record<string, string> {
  return {
    [MountMacros.RunId]: input.runId ?? runIdFromRunRoot(input.runRoot),
    [MountMacros.RunRoot]: input.runRoot,
    [MountMacros.ArtifactRoot]: input.artifactRoot,
    [MountMacros.AssetCommitId]: input.assetCommitId,
  };
}

function runIdFromRunRoot(runRoot: string): string {
  return runRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

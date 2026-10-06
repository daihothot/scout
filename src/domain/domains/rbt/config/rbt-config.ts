import { join } from "node:path";
import type { AssetConfig } from "../../../../asset-store/config/asset-config.js";

const RBT_CONFIG_FILE = "rbt.config.json";

export const RbtPlatforms = ["unity_editor", "android", "ios"] as const;
export type RbtPlatform = typeof RbtPlatforms[number];

/** Stable platform identity accepted at external RBT boundaries. */
export function isRbtPlatform(value: unknown): value is RbtPlatform {
  return RbtPlatforms.some((platform) => platform === value);
}

/** Physical configuration owned by one platform entry. */
export interface RbtExecutionSource {
  readonly transport?: string;
  readonly appId?: string;
  readonly artifactPath?: string;
}

/** Platform-keyed execution sources owned by the RBT Domain. */
export interface RbtConfig {
  readonly executionSources: Readonly<Partial<Record<RbtPlatform, RbtExecutionSource>>>;
}

/** Loads and validates the configuration owned by the RBT Domain. */
export function loadRbtConfig(config: AssetConfig): RbtConfig {
  const path = join(config.root, RBT_CONFIG_FILE);
  const value = config.read(RBT_CONFIG_FILE);
  if (!isRecord(value)) {
    throw new Error(`Invalid RBT config at ${path}: expected a JSON object.`);
  }
  assertKeys(value, ["executionSources"], path, "top-level");
  if (!isRecord(value.executionSources)) {
    throw new Error(`Invalid RBT config at ${path}: executionSources must be an object.`);
  }
  const executionSources: Partial<Record<RbtPlatform, RbtExecutionSource>> = {};
  for (const [platform, source] of Object.entries(value.executionSources)) {
    if (!isRbtPlatform(platform)) {
      throw new Error(`Invalid RBT config at ${path}: unknown execution platform ${platform}.`);
    }
    const field = `executionSources.${platform}`;
    if (!isRecord(source)) throw new Error(`Invalid RBT config at ${path}: ${field} must be an object.`);
    assertKeys(source, ["transport", "appId", "artifactPath"], path, field);
    const transport = optionalString(source.transport, path, `${field}.transport`);
    const appId = optionalString(source.appId, path, `${field}.appId`);
    const artifactPath = optionalString(source.artifactPath, path, `${field}.artifactPath`);
    executionSources[platform] = Object.freeze({
      ...(transport ? { transport } : {}),
      ...(appId ? { appId } : {}),
      ...(artifactPath ? { artifactPath } : {}),
    });
  }
  return Object.freeze({ executionSources: Object.freeze(executionSources) });
}

function optionalString(
  value: unknown,
  path: string,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid RBT config at ${path}: ${field} must be a string.`);
  }
  return value.trim();
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  scope: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid RBT config at ${path}: unknown ${scope} field(s): ${unknown.join(", ")}.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

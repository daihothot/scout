import { join, resolve } from "node:path";
import { readJsonFile } from "../../core/fs.js";

/** The global Scout configuration consumed by lifecycle services. */
export interface ScoutConfig {
  readonly restore: {
    readonly allowAssetResourceDrift: boolean;
  };
}

/** The fail-closed configuration used by isolated scope/unit-test construction. */
export const defaultScoutConfig: ScoutConfig = Object.freeze({
  restore: Object.freeze({
    allowAssetResourceDrift: false,
  }),
});

/** Returns the repository-level Scout configuration path. */
export function scoutConfigPath(scoutRoot: string): string {
  return join(resolve(scoutRoot), "assets", "scout", "config", "scout.config.json");
}

/** Loads and validates the global Scout configuration for one checkout. */
export function loadScoutConfig(scoutRoot: string): ScoutConfig {
  const path = scoutConfigPath(scoutRoot);
  return parseScoutConfig(readJsonFile<unknown>(path), path);
}

function parseScoutConfig(value: unknown, path: string): ScoutConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid Scout config at ${path}: expected a JSON object.`);
  }
  assertKeys(value, ["restore"], path, "top-level");
  const restore = value.restore;
  if (!isRecord(restore)) {
    throw new Error(`Invalid Scout config at ${path}: restore must be an object.`);
  }
  assertKeys(restore, ["allowAssetResourceDrift"], path, "restore");
  if (typeof restore.allowAssetResourceDrift !== "boolean") {
    throw new Error(
      `Invalid Scout config at ${path}: restore.allowAssetResourceDrift must be a boolean.`,
    );
  }
  return {
    restore: {
      allowAssetResourceDrift: restore.allowAssetResourceDrift,
    },
  };
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
      `Invalid Scout config at ${path}: unknown ${scope} field(s): ${unknown.join(", ")}.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

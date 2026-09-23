import { join, resolve } from "node:path";
import type { AssetConfig } from "../../asset-store/config/asset-config.js";

const SCOUT_CONFIG_FILE = "scout.config.json";

/** The global Scout configuration consumed by lifecycle services. */
export interface ScoutConfig {
  readonly workflow: {
    readonly profile: string;
  };
  readonly restore: {
    readonly allowAssetResourceDrift: boolean;
  };
}

/** The fail-closed configuration used by isolated scope/unit-test construction. */
export const defaultScoutConfig: ScoutConfig = Object.freeze({
  workflow: Object.freeze({
    profile: "validation",
  }),
  restore: Object.freeze({
    allowAssetResourceDrift: false,
  }),
});

/** Returns the repository-level Scout configuration path. */
export function scoutConfigPath(scoutRoot: string): string {
  return join(resolve(scoutRoot), "assets", "scout", "config", "scout.config.json");
}

/** Loads and validates the global Scout configuration through its Asset reader. */
export function loadScoutConfig(config: AssetConfig): ScoutConfig {
  const path = join(config.root, SCOUT_CONFIG_FILE);
  return parseScoutConfig(config.read(SCOUT_CONFIG_FILE), path);
}

function parseScoutConfig(value: unknown, path: string): ScoutConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid Scout config at ${path}: expected a JSON object.`);
  }
  assertKeys(value, ["workflow", "restore"], path, "top-level");
  const workflow = value.workflow;
  if (!isRecord(workflow)) {
    throw new Error(`Invalid Scout config at ${path}: workflow must be an object.`);
  }
  assertKeys(workflow, ["profile"], path, "workflow");
  if (typeof workflow.profile !== "string" || workflow.profile.trim().length === 0) {
    throw new Error(`Invalid Scout config at ${path}: workflow.profile must be a string.`);
  }
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
    workflow: {
      profile: workflow.profile.trim(),
    },
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

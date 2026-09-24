import { join } from "node:path";
import type { AssetConfig } from "../../../asset-store/config/asset-config.js";

const RBT_CONFIG_FILE = "rbt.config.json";

/** Physical execution target selected by the RBT Domain. */
export interface RbtConfig {
  readonly execution: {
    readonly transport?: string;
    readonly platform?: string;
    readonly appId?: string;
    readonly artifactPath?: string;
  };
}

/** Loads and validates the configuration owned by the RBT Domain. */
export function loadRbtConfig(config: AssetConfig): RbtConfig {
  const path = join(config.root, RBT_CONFIG_FILE);
  const value = config.read(RBT_CONFIG_FILE);
  if (!isRecord(value)) {
    throw new Error(`Invalid RBT config at ${path}: expected a JSON object.`);
  }
  assertKeys(value, ["execution"], path, "top-level");
  if (value.execution === undefined) {
    return { execution: {} };
  }
  if (!isRecord(value.execution)) {
    throw new Error(`Invalid RBT config at ${path}: execution must be an object.`);
  }
  assertKeys(
    value.execution,
    ["transport", "platform", "appId", "artifactPath"],
    path,
    "execution",
  );
  const transport = optionalString(value.execution.transport, path, "execution.transport");
  const platform = optionalString(value.execution.platform, path, "execution.platform");
  const appId = optionalString(value.execution.appId, path, "execution.appId");
  const artifactPath = optionalString(
    value.execution.artifactPath,
    path,
    "execution.artifactPath",
  );
  return {
    execution: {
      ...(transport ? { transport } : {}),
      ...(platform ? { platform } : {}),
      ...(appId ? { appId } : {}),
      ...(artifactPath ? { artifactPath } : {}),
    },
  };
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

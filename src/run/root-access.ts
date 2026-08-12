import { resolve } from "node:path";
import type { AssetStore } from "../asset-store/asset-store.js";
import type { ScoutAgentRole } from "../agent/thread/types.js";
import type {
  RunAgentEnvironment,
  RunRootAccess,
} from "./types.js";

/**
 * Derives deduplicated read, write, and mount roots from prepared role
 * mounts. It does not decide policy or mutate either the asset store or run.
 */
export function buildRunRootAccess(
  assetStore: Pick<
    AssetStore,
    "readableRootsForMount" | "writableRootsForMount"
  >,
  agents: Record<ScoutAgentRole, RunAgentEnvironment>,
): RunRootAccess {
  const preparedAgents = Object.values(agents);
  return {
    mountRoots: uniqueResolved(preparedAgents.map((agent) => agent.mount.mountRoot)),
    readableRoots: uniqueResolved(preparedAgents.flatMap((agent) =>
      assetStore.readableRootsForMount(agent.mount)
    )),
    writableRoots: uniqueResolved(preparedAgents.flatMap((agent) =>
      assetStore.writableRootsForMount(agent.mount)
    )),
  };
}

function uniqueResolved(values: string[]): string[] {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

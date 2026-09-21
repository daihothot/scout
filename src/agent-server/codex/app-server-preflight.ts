import { resolve } from "node:path";
import type { CodexMount } from "../../asset-store/contracts/mount.js";
import {
  createMountShellPreflight,
  inspectMountRootAccess,
} from "../../asset-store/mount/preflight.js";
import type { AgentServerPreflightReport } from "../types.js";
import type { CodexAppServerClient } from "./app-server-client.js";
import {
  discoverCodexMountCatalogs,
  type CodexMountCatalog,
} from "./preflight/app-server-catalog-preflight.js";
import { preflightCodexMountPlugins } from "./preflight/app-server-plugin-preflight.js";
import { readRedactedCodexConfigLayers } from "./preflight/preflight-summary.js";

export { summarizeAgentServerPreflight } from "./preflight/preflight-summary.js";

type MountShellPreflight = ReturnType<typeof createMountShellPreflight>;

/** Creates one Codex mount preflight with run-scoped shell-smoke reuse. */
export function createCodexAppServerMountPreflight(
  appServer: CodexAppServerClient,
  shellSmokeConcurrency: number,
): (mount: CodexMount) => Promise<AgentServerPreflightReport> {
  const shellPreflight = createMountShellPreflight(shellSmokeConcurrency);
  return (mount) => preflightCodexAppServerMountInternal({ mount, appServer }, shellPreflight);
}

/** Discovers Codex catalogs once, then preflights each prepared mount independently. */
export function createCodexAppServerMountPreflightBatch(
  appServer: CodexAppServerClient,
  shellSmokeConcurrency: number,
): (
  mounts: readonly CodexMount[],
) => Promise<ReadonlyMap<string, AgentServerPreflightReport>> {
  const shellPreflight = createMountShellPreflight(shellSmokeConcurrency);
  return async (mounts) => {
    if (mounts.length === 0) return new Map();
    let catalogs: ReadonlyMap<string, CodexMountCatalog>;
    try {
      catalogs = await discoverCodexMountCatalogs(appServer, mounts);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      return new Map(mounts.map((mount) => [
        resolve(mount.mountRoot),
        {
          status: "failed" as const,
          rootAccess: inspectMountRootAccess(mount),
          error: message,
        },
      ]));
    }

    const reports = await Promise.all(mounts.map(async (mount) => {
      const mountRoot = resolve(mount.mountRoot);
      const catalog = catalogs.get(mountRoot);
      if (!catalog) throw new Error(`Catalog discovery did not return ${mountRoot}.`);
      const report = await preflightCodexAppServerMountInternal(
        { mount, appServer, catalog },
        shellPreflight,
      );
      return [mountRoot, report] as const;
    }));
    return new Map(reports);
  };
}

/** Runs Mount and Codex-native checks for one prepared mount. */
export async function preflightCodexAppServerMount(input: {
  mount: CodexMount;
  appServer: CodexAppServerClient;
}): Promise<AgentServerPreflightReport> {
  return preflightCodexAppServerMountInternal(input, createMountShellPreflight(4));
}

async function preflightCodexAppServerMountInternal(
  input: {
    mount: CodexMount;
    appServer: CodexAppServerClient;
    catalog?: CodexMountCatalog;
  },
  shellPreflight: MountShellPreflight,
): Promise<AgentServerPreflightReport> {
  const { mount, appServer } = input;
  const result: AgentServerPreflightReport = {
    status: "failed",
  };

  try {
    result.rootAccess = inspectMountRootAccess(mount);
    const configRead = await appServer.request("config/read", {
      cwd: mount.mountRoot,
      includeLayers: true,
    });
    result.configLayers = readRedactedCodexConfigLayers(configRead);
    result.skillsList = input.catalog?.skillsList
      ?? await appServer.request("skills/list", {
        cwds: [mount.mountRoot],
        forceReload: true,
      });
    Object.assign(result, await preflightCodexMountPlugins(appServer, mount));
    result.hooksList = input.catalog?.hooksList
      ?? await appServer.request("hooks/list", {
        cwds: [mount.mountRoot],
      }).catch((error: unknown) => ({
        warning: error instanceof Error ? error.message : String(error),
      }));
    result.shellSmoke = await shellPreflight(mount);
    result.status = preflightPassed(result) ? "passed" : "failed";
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  }

  return result;
}

function preflightPassed(result: AgentServerPreflightReport): boolean {
  if (result.rootAccess?.status !== "passed") return false;
  if (result.shellSmoke?.some((item) => item.status !== "passed")) return false;
  if (result.pluginGate && result.pluginGate.status !== "passed") return false;
  return true;
}

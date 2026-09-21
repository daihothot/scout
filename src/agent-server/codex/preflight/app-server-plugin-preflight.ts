import { join } from "node:path";
import type { CodexMount } from "../../../asset-store/contracts/mount.js";
import type { AgentServerPreflightReport } from "../../types.js";
import type { CodexAppServerClient } from "../app-server-client.js";

type CodexPluginPreflightReport = Pick<
  AgentServerPreflightReport,
  | "pluginList"
  | "pluginInstalled"
  | "pluginInstall"
  | "pluginInstalledAfterInstall"
  | "pluginGate"
>;

/** Ensures the plugins declared by one Codex mount are installed and enabled. */
export async function preflightCodexMountPlugins(
  appServer: CodexAppServerClient,
  mount: CodexMount,
): Promise<CodexPluginPreflightReport> {
  const result: CodexPluginPreflightReport = {};
  if (mount.plugins.length === 0) return result;

  await appServer.withPluginManagerLock(async () => {
    result.pluginList = await appServer.request("plugin/list", {
      cwds: [mount.mountRoot],
    });
    result.pluginInstalled = await appServer.request("plugin/installed", {
      cwds: [mount.mountRoot],
      installSuggestionPluginNames: mount.plugins,
    });
    result.pluginGate = buildPluginGate({
      pluginNames: mount.plugins,
      marketplacePath: join(mount.mountRoot, ".agents", "plugins", "marketplace.json"),
      installedResponse: result.pluginInstalled,
    });
    if (result.pluginGate.plugins.some((plugin) => !plugin.installedBefore || !plugin.enabledBefore)) {
      const pluginInstallResults: unknown[] = [];
      for (const pluginName of mount.plugins) {
        pluginInstallResults.push(await appServer.request("plugin/install", {
          marketplacePath: result.pluginGate?.marketplacePath
            ?? join(mount.mountRoot, ".agents", "plugins", "marketplace.json"),
          pluginName,
        }).catch((error: unknown) => ({
          pluginName,
          error: error instanceof Error ? error.message : String(error),
        })));
      }
      result.pluginInstall = pluginInstallResults;
      result.pluginInstalledAfterInstall = await appServer.request("plugin/installed", {
        cwds: [mount.mountRoot],
        installSuggestionPluginNames: mount.plugins,
      });
      result.pluginGate = buildPluginGate({
        pluginNames: mount.plugins,
        marketplacePath: result.pluginGate.marketplacePath,
        installedResponse: result.pluginInstalledAfterInstall,
        before: result.pluginGate,
      });
    }
  });
  return result;
}

function buildPluginGate(input: {
  pluginNames: string[];
  marketplacePath: string;
  installedResponse: unknown;
  before?: AgentServerPreflightReport["pluginGate"];
}): NonNullable<AgentServerPreflightReport["pluginGate"]> {
  const plugins = input.pluginNames.map((pluginName) => {
    const plugin = findPluginSummary(input.installedResponse, pluginName);
    const before = input.before?.plugins.find((item) => item.pluginName === pluginName);
    const installedAfter = readBoolean(plugin, "installed");
    const enabledAfter = readBoolean(plugin, "enabled");
    return {
      pluginName,
      installedBefore: before?.installedBefore ?? installedAfter,
      enabledBefore: before?.enabledBefore ?? enabledAfter,
      installedAfter,
      enabledAfter,
    };
  });
  return {
    marketplacePath: input.marketplacePath,
    plugins,
    status: plugins.every((plugin) => plugin.installedAfter && plugin.enabledAfter) ? "passed" : "failed",
  };
}

function findPluginSummary(response: unknown, pluginName: string): Record<string, unknown> | undefined {
  const root = readObjectOrUndefined(response);
  const marketplaces = readArrayOrUndefined(root?.marketplaces);
  for (const marketplace of marketplaces ?? []) {
    const marketplaceObject = readObjectOrUndefined(marketplace);
    const plugins = readArrayOrUndefined(marketplaceObject?.plugins);
    for (const plugin of plugins ?? []) {
      const pluginObject = readObjectOrUndefined(plugin);
      if (pluginObject?.name === pluginName) return pluginObject;
    }
  }
  return undefined;
}

function readObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readArrayOrUndefined(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function readBoolean(object: Record<string, unknown> | undefined, key: string): boolean {
  return typeof object?.[key] === "boolean" ? object[key] : false;
}

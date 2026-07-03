import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CodexMount } from "../../asset-store/types.js";
import { buildMountShellEnvironment } from "../../asset-store/mount-macros.js";
import type { CodexAppServerClient } from "./app-server-client.js";
import type { AgentServerPreflightResult } from "../types.js";

const execFileAsync = promisify(execFile);

export async function preflightCodexAppServerMount(input: {
  mount: CodexMount;
  appServer: CodexAppServerClient;
}): Promise<AgentServerPreflightResult> {
  const { mount, appServer } = input;
  const result: AgentServerPreflightResult = {
    status: "failed",
  };

  try {
    const configRead = await appServer.request("config/read", {
      cwd: mount.mountRoot,
      includeLayers: true,
    });
    result.configLayers = readConfigLayers(configRead);
    result.skillsList = await appServer.request("skills/list", {
      cwds: [mount.mountRoot],
      forceReload: true,
    });
    result.pluginList = await appServer.request("plugin/list", {
      cwds: [mount.mountRoot],
    });
    if (mount.plugins.length > 0) {
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
        result.pluginInstall = await Promise.all(mount.plugins.map((pluginName) =>
          appServer.request("plugin/install", {
            marketplacePath: result.pluginGate?.marketplacePath ?? join(mount.mountRoot, ".agents", "plugins", "marketplace.json"),
            pluginName,
          }).catch((error: unknown) => ({
            pluginName,
            error: error instanceof Error ? error.message : String(error),
          }))
        ));
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
    }
    result.hooksList = await appServer.request("hooks/list", {
      cwds: [mount.mountRoot],
    }).catch((error: unknown) => ({
      warning: error instanceof Error ? error.message : String(error),
    }));
    result.shellSmoke = await smokeShellTools(mount);

    result.status = preflightPassed(result) ? "passed" : "failed";
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  }

  return result;
}

async function smokeShellTools(mount: CodexMount): Promise<AgentServerPreflightResult["shellSmoke"]> {
  const mountRoot = mount.mountRoot;
  const path = `${mountRoot}/bin:${process.env.PATH ?? ""}`;
  const tools = mount.shellTools.filter((tool) => tool.required);
  return Promise.all(tools.map((tool) =>
    execFileAsync("sh", ["-lc", shellSmokeCommand(tool.exposeAs, tool.smokeArgs ?? [])], {
      cwd: mountRoot,
      env: {
        ...process.env,
        PATH: path,
        ...buildMountShellEnvironment({
          runRoot: mount.runRoot,
          artifactRoot: mount.artifactRoot,
          assetCommitId: mount.assetCommitId,
        }),
      },
    }).then((output) => {
      const stdout = output.stdout.trim();
      const markerPassed = tool.marker ? stdout.includes(tool.marker) : true;
      return {
        command: [tool.exposeAs, ...(tool.smokeArgs ?? [])].join(" "),
        status: markerPassed ? "passed" as const : "failed" as const,
        stdout,
        stderr: output.stderr.trim(),
        error: markerPassed ? undefined : `Missing marker: ${tool.marker}`,
      };
    }).catch((error: unknown) => ({
      command: [tool.exposeAs, ...(tool.smokeArgs ?? [])].join(" "),
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
    }))
  ));
}

function preflightPassed(result: AgentServerPreflightResult): boolean {
  if (result.shellSmoke?.some((item) => item.status !== "passed")) return false;
  if (result.pluginGate && result.pluginGate.status !== "passed") return false;
  return true;
}

function readConfigLayers(response: unknown): unknown[] {
  const root = readObjectOrUndefined(response);
  return readArrayOrUndefined(root?.layers) ?? [];
}

function buildPluginGate(input: {
  pluginNames: string[];
  marketplacePath: string;
  installedResponse: unknown;
  before?: AgentServerPreflightResult["pluginGate"];
}): NonNullable<AgentServerPreflightResult["pluginGate"]> {
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

function shellSmokeCommand(exposeAs: string, smokeArgs: string[]): string {
  const executable = JSON.stringify(exposeAs);
  if (smokeArgs.length === 0) return `command -v ${executable}`;
  const args = smokeArgs.map((arg) => JSON.stringify(arg)).join(" ");
  return `command -v ${executable} && ${executable} ${args}`;
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

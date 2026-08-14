import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import type { CodexMount } from "../../asset-store/contracts/mount.js";
import { buildMountShellEnvironment } from "../../asset-store/mount/macros.js";
import { isPathWithin } from "../../core/path.js";
import type { CodexAppServerClient } from "./app-server-client.js";
import type { AgentServerPreflightReport } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Keep the runtime RPC responses available to the gate, but persist only a
 * portable diagnostic projection. Codex catalog responses contain descriptions,
 * interfaces, source paths, and other device-local payloads that are not facts
 * needed to resume a Scout run.
 */
export function summarizeAgentServerPreflight(
  report: AgentServerPreflightReport,
  mount: Pick<CodexMount, "scoutRoot" | "runRoot" | "mountRoot" | "artifactRoot">,
): AgentServerPreflightReport {
  const summary: AgentServerPreflightReport = {
    status: report.status,
  };
  if (report.rootAccess) {
    summary.rootAccess = {
      status: report.rootAccess.status,
      roots: report.rootAccess.roots.map((root) => ({
        path: portablePreflightPath(root.path, mount),
        access: root.access,
        status: root.status,
        ...(root.error ? { error: summarizeError(root.error) } : {}),
      })),
    };
  }
  if (report.configLayers) {
    summary.configLayers = summarizeConfigLayers(report.configLayers, mount);
  }
  if (report.skillsList !== undefined) {
    summary.skillsList = summarizeSkillsList(report.skillsList, mount);
  }
  if (report.pluginList !== undefined) {
    summary.pluginList = summarizePluginList(report.pluginList);
  }
  if (report.pluginInstalled !== undefined) {
    summary.pluginInstalled = summarizePluginStates(report.pluginInstalled);
  }
  if (report.pluginInstall !== undefined) {
    summary.pluginInstall = summarizePluginInstall(report.pluginInstall);
  }
  if (report.pluginInstalledAfterInstall !== undefined) {
    summary.pluginInstalledAfterInstall = summarizePluginStates(
      report.pluginInstalledAfterInstall,
    );
  }
  if (report.pluginGate) {
    summary.pluginGate = {
      marketplacePath: portablePreflightPath(report.pluginGate.marketplacePath, mount),
      plugins: report.pluginGate.plugins.map((plugin) => ({ ...plugin })),
      status: report.pluginGate.status,
    };
  }
  if (report.hooksList !== undefined) {
    summary.hooksList = summarizeHooksList(report.hooksList, mount);
  }
  if (report.shellSmoke) {
    summary.shellSmoke = report.shellSmoke.map((item) => ({
      command: item.command,
      status: item.status,
      ...(item.status === "failed" && item.stdout ? { stdout: summarizeError(item.stdout) } : {}),
      ...(item.status === "failed" && item.stderr ? { stderr: summarizeError(item.stderr) } : {}),
      ...(item.error ? { error: summarizeError(item.error) } : {}),
    }));
  }
  if (report.error) summary.error = summarizeError(report.error);
  return summary;
}

/** Runs root, Codex catalog, plugin, hook, and shell smoke checks for one mount. */
export async function preflightCodexAppServerMount(input: {
  mount: CodexMount;
  appServer: CodexAppServerClient;
}): Promise<AgentServerPreflightReport> {
  const { mount, appServer } = input;
  const result: AgentServerPreflightReport = {
    status: "failed",
  };

  try {
    result.rootAccess = inspectRootAccess(mount);
    const configRead = await appServer.request("config/read", {
      cwd: mount.mountRoot,
      includeLayers: true,
    });
    result.configLayers = readConfigLayers(configRead).map(redactConfigLayer);
    result.skillsList = await appServer.request("skills/list", {
      cwds: [mount.mountRoot],
      forceReload: true,
    });
    if (mount.plugins.length > 0) {
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

async function smokeShellTools(mount: CodexMount): Promise<AgentServerPreflightReport["shellSmoke"]> {
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

function preflightPassed(result: AgentServerPreflightReport): boolean {
  if (result.rootAccess?.status !== "passed") return false;
  if (result.shellSmoke?.some((item) => item.status !== "passed")) return false;
  if (result.pluginGate && result.pluginGate.status !== "passed") return false;
  return true;
}

function inspectRootAccess(mount: CodexMount): NonNullable<AgentServerPreflightReport["rootAccess"]> {
  const writableRoots = new Set([
    mount.artifactRoot,
    ...mount.writableRoots,
    ...mount.mcpServers.flatMap((server) => server.writableRoots),
  ]);
  const readableRoots = new Set([
    mount.mountRoot,
    ...mount.readableRoots,
  ]);
  const roots = [...new Set([
    ...readableRoots,
    ...writableRoots,
  ])].map((path) => {
    const access = writableRoots.has(path)
      ? "writable" as const
      : readableRoots.has(path)
      ? "readable" as const
      : "readable" as const;
    try {
      if (!statSync(path).isDirectory()) {
        throw new Error("path is not a directory");
      }
      accessSync(
        path,
        constants.R_OK | (access === "writable" ? constants.W_OK : 0),
      );
      return { path, access, status: "passed" as const };
    } catch (error) {
      return {
        path,
        access,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return {
    status: roots.every((root) => root.status === "passed") ? "passed" : "failed",
    roots,
  };
}

function readConfigLayers(response: unknown): unknown[] {
  const root = readObjectOrUndefined(response);
  return readArrayOrUndefined(root?.layers) ?? [];
}

function redactConfigLayer(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigLayer);
  const object = readObjectOrUndefined(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => {
    const normalized = key.toLowerCase();
    const sensitive = normalized.includes("secret")
      || normalized.includes("token")
      || normalized.includes("password")
      || normalized.includes("credential")
      || normalized.includes("apikey")
      || normalized.includes("api_key")
      || normalized === "authorization";
    return [key, sensitive ? "[redacted]" : redactConfigLayer(entry)];
  }));
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

function portablePreflightPath(
  path: string,
  mount: Pick<CodexMount, "scoutRoot" | "runRoot" | "mountRoot" | "artifactRoot">,
): string {
  const normalizedPath = resolve(path);
  const roots: Array<[string, string]> = [
    [mount.mountRoot, "${SCOUT_MOUNT_ROOT}"],
    [mount.artifactRoot, "${SCOUT_ARTIFACT_ROOT}"],
    [mount.runRoot, "${SCOUT_RUN_ROOT}"],
    [mount.scoutRoot, "${SCOUT_ROOT}"],
  ];
  roots.sort(([left], [right]) => right.length - left.length);
  for (const [root, macro] of roots) {
    if (!isPathWithin(root, normalizedPath)) continue;
    const child = relative(resolve(root), normalizedPath);
    return child.length === 0
      ? macro
      : `${macro}/${child.split(sep).join("/")}`;
  }
  // External profile roots are intentionally represented by a stable label,
  // rather than carrying a source-device absolute path into the run artifact.
  return basename(normalizedPath) || "<root>";
}

function summarizeConfigLayers(
  layers: unknown[],
  mount: Pick<CodexMount, "scoutRoot" | "runRoot" | "mountRoot" | "artifactRoot">,
): unknown[] {
  return layers.map((layer) => {
    const object = readObjectOrUndefined(layer);
    if (!object) return { kind: typeof layer };
    const name = readObjectOrUndefined(object.name);
    const config = readObjectOrUndefined(object.config);
    return {
      ...(name ? {
        name: {
          ...(typeof name.type === "string" ? { type: name.type } : {}),
          ...(typeof name.dotCodexFolder === "string"
            ? { dotCodexFolder: portablePreflightPath(name.dotCodexFolder, mount) }
            : {}),
          ...(typeof name.file === "string"
            ? { file: portablePreflightPath(name.file, mount) }
            : {}),
        },
      } : {}),
      ...(typeof object.version === "string" ? { version: object.version } : {}),
      configKeys: config ? Object.keys(config).sort() : [],
    };
  });
}

function summarizeSkillsList(
  response: unknown,
  mount: Pick<CodexMount, "scoutRoot" | "runRoot" | "mountRoot" | "artifactRoot">,
): unknown {
  const root = readObjectOrUndefined(response);
  const data = readArrayOrUndefined(root?.data) ?? [];
  let totalSkills = 0;
  const entries = data.map((entry) => {
    const object = readObjectOrUndefined(entry);
    const skills = readArrayOrUndefined(object?.skills) ?? [];
    totalSkills += skills.length;
    return {
      ...(typeof object?.cwd === "string"
        ? { cwd: portablePreflightPath(object.cwd, mount) }
        : {}),
      skillCount: skills.length,
      skills: skills.flatMap((skill) => {
        const value = readObjectOrUndefined(skill);
        return typeof value?.name === "string"
          ? [{
              name: value.name,
              ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
              ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
            }]
          : [];
      }),
      errors: summarizeMessages(object?.errors),
    };
  });
  return {
    data: entries,
    totalSkills,
    errors: summarizeMessages(root?.errors),
  };
}

function summarizePluginList(response: unknown): unknown {
  const root = readObjectOrUndefined(response);
  const marketplaces = readArrayOrUndefined(root?.marketplaces) ?? [];
  const summaries = marketplaces.map((marketplace) => {
    const value = readObjectOrUndefined(marketplace);
    const plugins = readArrayOrUndefined(value?.plugins) ?? [];
    return {
      ...(typeof value?.name === "string" ? { name: value.name } : {}),
      pluginCount: plugins.length,
      plugins: plugins.flatMap((plugin) => summarizePluginEntry(plugin)),
    };
  });
  const plugins = summaries.flatMap((marketplace) => marketplace.plugins);
  return {
    marketplaces: summaries,
    marketplaceCount: summaries.length,
    pluginCount: plugins.length,
    installedCount: plugins.filter((plugin) => plugin.installed).length,
    enabledCount: plugins.filter((plugin) => plugin.enabled).length,
    marketplaceLoadErrors: summarizeMessages(root?.marketplaceLoadErrors),
  };
}

function summarizePluginStates(response: unknown): unknown {
  const root = readObjectOrUndefined(response);
  const entries = [
    ...(readArrayOrUndefined(root?.plugins) ?? []),
    ...(readArrayOrUndefined(root?.data) ?? []),
    ...(Array.isArray(response) ? response : []),
  ].flatMap((entry) => summarizePluginEntry(entry));
  return {
    plugins: entries,
    pluginCount: entries.length,
    installedCount: entries.filter((plugin) => plugin.installed).length,
    enabledCount: entries.filter((plugin) => plugin.enabled).length,
    errors: summarizeMessages(root?.errors),
  };
}

function summarizePluginInstall(response: unknown): unknown {
  const entries = Array.isArray(response) ? response : [response];
  return entries.flatMap((entry) => {
    const value = readObjectOrUndefined(entry);
    if (!value) return [];
    return [{
      ...(typeof value.pluginName === "string" ? { pluginName: value.pluginName } : {}),
      ...(typeof value.status === "string" ? { status: value.status } : {}),
      ...(typeof value.error === "string" ? { error: summarizeError(value.error) } : {}),
    }];
  });
}

function summarizePluginEntry(value: unknown): Array<{
  id?: string;
  name: string;
  installed: boolean;
  enabled: boolean;
}> {
  const object = readObjectOrUndefined(value);
  if (!object || typeof object.name !== "string") return [];
  return [{
    ...(typeof object.id === "string" ? { id: object.id } : {}),
    name: object.name,
    installed: readBoolean(object, "installed"),
    enabled: readBoolean(object, "enabled"),
  }];
}

function summarizeHooksList(
  response: unknown,
  mount: Pick<CodexMount, "scoutRoot" | "runRoot" | "mountRoot" | "artifactRoot">,
): unknown {
  const root = readObjectOrUndefined(response);
  const data = readArrayOrUndefined(root?.data) ?? [];
  return {
    data: data.map((entry) => {
      const object = readObjectOrUndefined(entry);
      const hooks = readArrayOrUndefined(object?.hooks) ?? [];
      return {
        ...(typeof object?.cwd === "string"
          ? { cwd: portablePreflightPath(object.cwd, mount) }
          : {}),
        hookCount: hooks.length,
        warnings: summarizeMessages(object?.warnings),
        errors: summarizeMessages(object?.errors),
      };
    }),
    warnings: summarizeMessages(root?.warnings),
    errors: summarizeMessages(root?.errors),
  };
}

function summarizeMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [summarizeError(entry)];
    const object = readObjectOrUndefined(entry);
    if (!object) return [];
    const message = object.message ?? object.error ?? object.code;
    return typeof message === "string" ? [summarizeError(message)] : [];
  });
}

function summarizeError(value: string): string {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? value;
  return firstLine.length > 500 ? `${firstLine.slice(0, 497)}...` : firstLine;
}

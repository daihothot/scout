import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { CodexMount } from "../../asset-store/types.js";
import { collectMountTrustedRoots } from "../../asset-store/preflight.js";
import { buildMountShellEnvironment } from "../../asset-store/mount-macros.js";
import { CodexAppServerClient } from "./app-server-client.js";
import type { AgentServerPreflightResult } from "../types.js";

const execFileAsync = promisify(execFile);

export async function preflightCodexMount(mount: CodexMount): Promise<AgentServerPreflightResult> {
  const isolatedHome = mkdtempSync(join(tmpdir(), "scout-runtime-home-"));
  const isolatedCodexHome = join(isolatedHome, ".codex");
  mkdirSync(isolatedCodexHome, { recursive: true });
  writeFileSync(join(isolatedCodexHome, "config.toml"), buildIsolatedConfig({
    mountRoots: [mount.mountRoot],
    trustedRoots: collectMountTrustedRoots(mount),
  }), "utf8");

  const result: AgentServerPreflightResult = {
    status: "failed",
    isolatedHome,
    isolatedCodexHome,
  };
  const client = new CodexAppServerClient({
    home: isolatedHome,
    codexHome: isolatedCodexHome,
    logPrefix: "scout runtime app-server",
  });

  try {
    await client.startSession();
    result.configRead = await client.request("config/read", {
      cwd: mount.mountRoot,
      includeLayers: true,
    });
    result.skillsList = await client.request("skills/list", {
      cwds: [mount.mountRoot],
      forceReload: true,
    });
    result.pluginList = await client.request("plugin/list", {
      cwds: [mount.mountRoot],
    });
    if (mount.plugins.length > 0) {
      result.pluginInstalled = await client.request("plugin/installed", {
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
          client.request("plugin/install", {
            marketplacePath: result.pluginGate?.marketplacePath ?? join(mount.mountRoot, ".agents", "plugins", "marketplace.json"),
            pluginName,
          }).catch((error: unknown) => ({
            pluginName,
            error: error instanceof Error ? error.message : String(error),
          }))
        ));
        result.pluginInstalledAfterInstall = await client.request("plugin/installed", {
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
    result.hooksList = await client.request("hooks/list", {
      cwds: [mount.mountRoot],
    }).catch((error: unknown) => ({
      warning: error instanceof Error ? error.message : String(error),
    }));
    result.shellSmoke = await smokeShellTools(mount);

    result.status = preflightPassed(result) ? "passed" : "failed";
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    client.close();
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

function buildIsolatedConfig(input: { mountRoots: string[]; trustedRoots: string[] }): string {
  const homeConfig = readHomeProviderConfig();
  const mountRoots = [...new Set(input.mountRoots.map((root) => resolve(root)))];
  const lines = [
    'model = "gpt-5.4-mini"',
    'model_provider = "GuruOpenAI"',
    "",
    "[features]",
    "shell_snapshot = false",
    "",
    "[model_providers.GuruOpenAI]",
    'name = "GuruOpenAI"',
    `base_url = "${escapeToml(homeConfig.baseUrl ?? "https://api.openai.com/v1")}"`,
    `env_key = "${escapeToml(homeConfig.envKey ?? "OPENAI_API_KEY")}"`,
    'wire_api = "responses"',
    "",
  ];
  for (const mountRoot of mountRoots) {
    lines.push(
      `[projects."${escapeToml(mountRoot)}"]`,
      'trust_level = "trusted"',
      "",
    );
  }
  for (const trustedRoot of input.trustedRoots) {
    if (mountRoots.includes(resolve(trustedRoot))) continue;
    lines.push(
      `[projects."${escapeToml(resolve(trustedRoot))}"]`,
      'trust_level = "trusted"',
      "",
    );
  }
  return lines.join("\n");
}

function readHomeProviderConfig(): { baseUrl?: string; envKey?: string } {
  try {
    const text = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const block = text.match(/^\[model_providers\.GuruOpenAI\]\n([\s\S]*?)(?=^\[|\z)/m)?.[1] ?? "";
    return {
      baseUrl: block.match(/^base_url\s*=\s*"([^"]*)"/m)?.[1],
      envKey: block.match(/^env_key\s*=\s*"([^"]*)"/m)?.[1],
    };
  } catch {
    return {};
  }
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

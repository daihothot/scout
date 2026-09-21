import {
  basename,
  relative,
  resolve,
  sep,
} from "node:path";
import type { CodexMount } from "../../../asset-store/contracts/mount.js";
import { isPathWithin } from "../../../core/path.js";
import type { AgentServerPreflightReport } from "../../types.js";

/** Keeps portable diagnostics while dropping device-local Codex response payloads. */
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
      durationMs: item.durationMs,
      ...(item.status === "failed" && item.stdout ? { stdout: summarizeError(item.stdout) } : {}),
      ...(item.status === "failed" && item.stderr ? { stderr: summarizeError(item.stderr) } : {}),
      ...(item.error ? { error: summarizeError(item.error) } : {}),
    }));
  }
  if (report.error) summary.error = summarizeError(report.error);
  return summary;
}

/** Reads config layers from Codex and removes credential-shaped values. */
export function readRedactedCodexConfigLayers(response: unknown): unknown[] {
  const root = readObjectOrUndefined(response);
  return (readArrayOrUndefined(root?.layers) ?? []).map(redactConfigLayer);
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

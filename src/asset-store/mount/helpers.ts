import { chmodSync, existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeJsonFile, writeTextFile } from "../../core/fs.js";
import type {
  MaterializedMcpServer,
  McpServersFile,
  MountMaterializationIssue,
  ShellToolContract,
} from "../types.js";
import {
  buildMountMacroValues,
  buildMountShellEnvironment,
  resolveMountMacros,
  type MountMacroValuesInput,
} from "./macros.js";

/** Macro inputs shared by the mount config and command materializers. */
export type MountDynamicValuesInput = MountMacroValuesInput;

/** Inputs used to turn MCP contracts into executable mount-local wrappers. */
export interface MaterializeMcpServersOptions {
  mountRoot: string;
  mcpServers: McpServersFile;
  assetsRoot: string;
  dynamicValues: Record<string, string | undefined>;
}

/** Inputs used to render the generated Codex config layer for one mount. */
export interface GenerateCodexConfigOptions {
  baseConfig: string;
  mountRoot: string;
  runRoot: string;
  artifactRoot: string;
  runId: string;
  assetCommitId: string;
  mcpServers: MaterializedMcpServer[];
}

/** Builds the dynamic values consumed by MCP, shell, and config expansion. */
export function buildMountDynamicValues(input: MountDynamicValuesInput): Record<string, string | undefined> {
  return buildMountMacroValues(input);
}

/** Writes one wrapper per configured MCP server and returns resolved contracts. */
export function materializeMcpServers(options: MaterializeMcpServersOptions): MaterializedMcpServer[] {
  return Object.entries(options.mcpServers.servers).flatMap(([name, server]) => {
    assertMountPathSegment(name, "MCP server name");
    const wrapperPath = join(options.mountRoot, "mcp", name);
    const dynamicValues = options.dynamicValues;
    const command = resolveCommand(resolveDynamicValue(server.command, dynamicValues), options.assetsRoot);
    const args = (server.args ?? [])
      .map((arg) => resolveDynamicValue(arg, dynamicValues))
      .filter((arg): arg is string => arg.length > 0)
      .map((arg) => resolveAssetArg(arg, options.assetsRoot));
    const cwd = server.cwd ? resolveDynamicValue(server.cwd, dynamicValues) : undefined;
    const env = server.env ? resolveDynamicEnv(server.env, dynamicValues) : undefined;
    const trustedRoots = (server.trustedRoots ?? [])
      .map((root) => resolveDynamicValue(root, dynamicValues))
      .filter((root) => root.length > 0)
      .map((root) => resolve(root));
    const writableRoots = (server.writableRoots ?? [])
      .map((root) => resolveDynamicValue(root, dynamicValues))
      .filter((root) => root.length > 0)
      .map((root) => resolve(root));
    const exports = [
      ...(cwd ? [`cd ${JSON.stringify(cwd)}`] : []),
      ...Object.entries(env ?? {}).map(([key, value]) => `export ${key}=${JSON.stringify(value)}`),
    ];
    const script = [
      "#!/bin/sh",
      ...exports,
      `exec ${JSON.stringify(command)} ${args.map((arg) => JSON.stringify(arg)).join(" ")} "$@"`,
      "",
    ].join("\n");
    writeTextFile(wrapperPath, script);
    chmodSync(wrapperPath, 0o755);
    return {
      name,
      wrapperPath,
      command,
      args,
      cwd,
      env,
      trustedRoots,
      writableRoots,
      smoke: server.smoke
        ? {
          tool: server.smoke.tool,
          arguments: resolveDynamicRecord(server.smoke.arguments ?? {}, dynamicValues),
        }
        : undefined,
    };
  });
}

/** Writes the local plugin marketplace descriptor consumed by Codex preflight. */
export function writePluginMarketplace(mountRoot: string, pluginNames: string[]): void {
  const marketplace = {
    name: "scout-runtime-marketplace",
    interface: {
      displayName: "Scout Runtime Marketplace",
    },
    plugins: pluginNames.map((name) => ({
      name,
      source: {
        source: "local",
        path: `./plugins/${name}`,
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    })),
  };
  writeJsonFile(join(mountRoot, ".agents", "plugins", "marketplace.json"), marketplace);
}

/** Creates executable shell-tool wrappers and reports unresolved contracts as issues. */
export function materializeShellTools(
  mountRoot: string,
  tools: ShellToolContract[],
  assetsRoot: string,
): {
  shellTools: ShellToolContract[];
  wrappers: Array<{ id: string; wrapperPath: string }>;
  issues: MountMaterializationIssue[];
} {
  const shellTools: ShellToolContract[] = [];
  const wrappers: Array<{ id: string; wrapperPath: string }> = [];
  const issues: MountMaterializationIssue[] = [];

  for (const tool of tools) {
    assertMountPathSegment(tool.exposeAs, `shell tool exposeAs for ${tool.id}`);
    const wrapperPath = join(mountRoot, "bin", tool.exposeAs);
    const command = resolveShellToolCommand(tool, assetsRoot);
    if (!command) {
      const message = `Shell tool command could not be resolved: ${tool.id} (${tool.command})`;
      issues.push({
        severity: tool.required ? "error" : "warning",
        code: "shell_tool_unresolved",
        message,
        resourceId: tool.id,
        detail: {
          name: tool.name,
          command: tool.command,
          exposeAs: tool.exposeAs,
          required: tool.required,
        },
      });
      continue;
    }
    const args = [...(tool.args ?? []), ...[]]
      .map((arg) => JSON.stringify(resolveAssetArg(arg, assetsRoot)))
      .join(" ");
    const script = [
      "#!/bin/sh",
      `exec ${JSON.stringify(command)} ${args} "$@"`,
      "",
    ].join("\n");
    writeTextFile(wrapperPath, script);
    chmodSync(wrapperPath, 0o755);
    shellTools.push(tool);
    wrappers.push({ id: tool.id, wrapperPath });
  }

  return {
    shellTools,
    wrappers,
    issues,
  };
}

/** Renders the base config plus runtime environment and MCP wrapper sections. */
export function generateCodexConfig(input: GenerateCodexConfigOptions): string {
  const lines = [
    input.baseConfig.trimEnd(),
    "",
    "[shell_environment_policy.set]",
    `PATH = "${escapeToml(`${input.mountRoot}/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`)}"`,
    ...Object.entries(buildMountShellEnvironment({
      runRoot: input.runRoot,
      artifactRoot: input.artifactRoot,
      assetCommitId: input.assetCommitId,
      runId: input.runId,
    })).map(([key, value]) => `${key} = "${escapeToml(value)}"`),
    "GIT_OPTIONAL_LOCKS = \"0\"",
    "",
  ];

  for (const server of input.mcpServers) {
    lines.push(`[mcp_servers.${server.name}]`);
    lines.push(`command = "${escapeToml(server.wrapperPath)}"`);
    lines.push("args = []");
    if (server.cwd) {
      lines.push(`cwd = "${escapeToml(server.cwd)}"`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${server.name}.env]`);
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`${key} = "${escapeToml(value)}"`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function resolveDynamicEnv(
  env: Record<string, string>,
  dynamicValues: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .map(([key, value]) => [key, resolveDynamicValue(value, dynamicValues)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1].length > 0),
  );
}

function resolveDynamicValue(value: string, dynamicValues: Record<string, string | undefined>): string {
  return resolveMountMacros(value, dynamicValues);
}

function resolveDynamicUnknown(value: unknown, dynamicValues: Record<string, string | undefined>): unknown {
  if (typeof value === "string") return resolveDynamicValue(value, dynamicValues);
  if (Array.isArray(value)) return value.map((item) => resolveDynamicUnknown(item, dynamicValues));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, resolveDynamicUnknown(child, dynamicValues)]),
  );
}

function resolveDynamicRecord(
  value: Record<string, unknown>,
  dynamicValues: Record<string, string | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, resolveDynamicUnknown(child, dynamicValues)]),
  );
}

/** Resolves an MCP command, preserving an unresolved bare name for Codex diagnostics. */
export function resolveCommand(command: string, assetsRoot: string): string {
  if (command === "node") return process.execPath;
  if (command.startsWith("assets/")) return resolveAssetLocalPath(command, assetsRoot);
  if (existsSync(command)) return command;
  return resolveExecutableFromPath(command) ?? command;
}

/** Resolves a shell-tool executable; returns undefined when its contract is unusable. */
export function resolveShellToolCommand(tool: ShellToolContract, assetsRoot: string): string | undefined {
  const command = tool.command;
  if (command === "node") return process.execPath;
  if (command.startsWith("assets/")) {
    const assetPath = resolveAssetLocalPath(command, assetsRoot);
    return existsSync(assetPath) ? assetPath : undefined;
  }
  if (existsSync(command)) return command;
  if (command.includes("/") || isAbsolute(command)) return undefined;
  return resolveExecutableFromPath(command);
}

/** Resolves an `assets/...` command argument against the repository asset root. */
export function resolveAssetArg(arg: string, assetsRoot: string): string {
  return arg.startsWith("assets/") ? resolveAssetLocalPath(arg, assetsRoot) : arg;
}

/** Resolves an asset-local command path and rejects traversal outside `assetsRoot`. */
export function resolveAssetLocalPath(assetPath: string, assetsRoot: string): string {
  const repoRoot = resolve(assetsRoot, "..", "..");
  const resolvedPath = resolve(repoRoot, assetPath);
  const relativePath = relative(resolve(assetsRoot), resolvedPath);
  if (
    relativePath.length > 0
    && (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(".." + sep))
  ) {
    throw new Error(`Asset-local path escapes assets root: ${assetPath}`);
  }
  return resolvedPath;
}

/** Rejects names that could introduce path traversal or multi-segment mount paths. */
export function assertMountPathSegment(value: string, label: string): void {
  if (value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function resolveExecutableFromPath(command: string): string | undefined {
  if (command.includes("/") || isAbsolute(command)) return undefined;
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry.trim().length === 0) continue;
    const candidate = join(entry, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

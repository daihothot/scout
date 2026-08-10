import { join, resolve } from "node:path";
import type {
  MaterializedMcpServer,
  McpServersFile,
} from "../contracts/resources.js";
import {
  assertMountPathSegment,
  resolveAssetArg,
} from "../files/asset-paths.js";
import { resolveCommand } from "../files/command-resolution.js";
import { resolveMountMacros } from "../mount/macros.js";

/** Canonical current-device wrapper projection for one MCP server. */
export interface BuiltMcpServer {
  server: MaterializedMcpServer;
  wrapperContent: string;
}

/** Inputs used to resolve MCP contracts after the run and mount roots exist. */
export interface McpServerBuilderOptions {
  mountRoot: string;
  assetsRoot: string;
  dynamicValues: Record<string, string | undefined>;
}

/** Resolves MCP contracts and renders wrappers without touching the mount filesystem. */
export class McpServerBuilder {
  constructor(private readonly options: McpServerBuilderOptions) {}

  build(contracts: McpServersFile): BuiltMcpServer[] {
    return Object.entries(contracts.servers).map(([name, contract]) => {
      assertMountPathSegment(name, "MCP server name");
      const dynamicValues = this.options.dynamicValues;
      const wrapperPath = join(this.options.mountRoot, "mcp", name);
      const command = resolveCommand(
        resolveMountMacros(contract.command, dynamicValues),
        this.options.assetsRoot,
      );
      const args = (contract.args ?? [])
        .map((argument) => resolveMountMacros(argument, dynamicValues))
        .filter((argument) => argument.length > 0)
        .map((argument) => resolveAssetArg(argument, this.options.assetsRoot));
      const cwd = contract.cwd
        ? resolveMountMacros(contract.cwd, dynamicValues)
        : undefined;
      const env = contract.env
        ? Object.fromEntries(Object.entries(contract.env)
          .map(([key, value]) => [key, resolveMountMacros(value, dynamicValues)] as const)
          .filter((entry) => entry[1].length > 0))
        : undefined;
      const trustedRoots = (contract.trustedRoots ?? [])
        .map((root) => resolveMountMacros(root, dynamicValues))
        .filter((root) => root.length > 0)
        .map((root) => resolve(root));
      const writableRoots = (contract.writableRoots ?? [])
        .map((root) => resolveMountMacros(root, dynamicValues))
        .filter((root) => root.length > 0)
        .map((root) => resolve(root));
      const server: MaterializedMcpServer = {
        name,
        wrapperPath,
        command,
        args,
        cwd,
        env,
        trustedRoots,
        writableRoots,
        smoke: contract.smoke
          ? {
            tool: contract.smoke.tool,
            arguments: resolveDynamicRecord(contract.smoke.arguments ?? {}, dynamicValues),
          }
          : undefined,
      };
      const exports = [
        ...(cwd ? [`cd ${JSON.stringify(cwd)}`] : []),
        ...Object.entries(env ?? {}).map(([key, value]) =>
          `export ${key}=${JSON.stringify(value)}`
        ),
      ];
      return {
        server,
        wrapperContent: [
          "#!/bin/sh",
          ...exports,
          `exec ${JSON.stringify(command)} ${args.map((argument) => JSON.stringify(argument)).join(" ")} "$@"`,
          "",
        ].join("\n"),
      };
    });
  }
}

function resolveDynamicValue(
  value: unknown,
  dynamicValues: Record<string, string | undefined>,
): unknown {
  if (typeof value === "string") return resolveMountMacros(value, dynamicValues);
  if (Array.isArray(value)) return value.map((item) => resolveDynamicValue(item, dynamicValues));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    resolveDynamicValue(child, dynamicValues),
  ]));
}

function resolveDynamicRecord(
  value: Record<string, unknown>,
  dynamicValues: Record<string, string | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    resolveDynamicValue(child, dynamicValues),
  ]));
}

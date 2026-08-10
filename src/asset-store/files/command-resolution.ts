import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ShellToolContract } from "../contracts/resources.js";
import { resolveAssetLocalPath } from "./asset-paths.js";

/** Resolves an MCP command, preserving an unresolved bare name for Codex diagnostics. */
export function resolveCommand(command: string, assetsRoot: string): string {
  if (command === "node") return process.execPath;
  if (command.startsWith("assets/")) return resolveAssetLocalPath(command, assetsRoot);
  if (existsSync(command)) return command;
  return resolveExecutableFromPath(command) ?? command;
}

/** Resolves a shell-tool executable; returns undefined when its contract is unusable. */
export function resolveShellToolCommand(
  tool: ShellToolContract,
  assetsRoot: string,
): string | undefined {
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

function resolveExecutableFromPath(command: string): string | undefined {
  if (command.includes("/") || isAbsolute(command)) return undefined;
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry.trim().length === 0) continue;
    const candidate = join(entry, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

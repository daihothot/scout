import type { CodexMount } from "../types.js";

/** Returns unique trusted roots required by the mount and its MCP servers. */
export function collectMountTrustedRoots(mount: CodexMount): string[] {
  return uniqueStrings([
    ...mount.trustedRoots,
    ...mount.mcpServers.flatMap((server) => server.trustedRoots),
  ]);
}

/** Returns unique writable roots required by the mount and its MCP servers. */
export function collectMountWritableRoots(mount: CodexMount): string[] {
  return uniqueStrings([
    ...mount.writableRoots,
    ...mount.mcpServers.flatMap((server) => server.writableRoots),
  ]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

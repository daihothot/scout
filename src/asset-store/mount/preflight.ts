import type { CodexMount } from "../contracts/mount.js";

/** Returns the Agent-shell readable roots owned by runtime and the role profile. */
export function collectMountReadableRoots(mount: CodexMount): string[] {
  return uniqueStrings([
    mount.mountRoot,
    ...mount.readableRoots,
  ]);
}

/** Returns unique writable roots required by the mount and its MCP servers. */
export function collectMountWritableRoots(mount: CodexMount): string[] {
  return uniqueStrings([
    mount.artifactRoot,
    mount.tempRoot,
    ...mount.writableRoots,
    ...mount.mcpServers.flatMap((server) => server.writableRoots),
  ]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

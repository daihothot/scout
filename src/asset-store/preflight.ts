import type { CodexMount } from "./types.js";

export function collectMountTrustedRoots(mount: CodexMount): string[] {
  return uniqueStrings([
    ...mount.trustedRoots,
    ...mount.mcpServers.flatMap((server) => server.trustedRoots),
  ]);
}

export function collectMountWritableRoots(mount: CodexMount): string[] {
  return uniqueStrings([
    ...mount.writableRoots,
    ...mount.mcpServers.flatMap((server) => server.writableRoots),
  ]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { sha256Text } from "../../core/fs.js";
import type { BuiltMcpServer } from "../builders/mcp-server-builder.js";
import type { MountManifest } from "../contracts/manifest.js";
import type { MountContext } from "../contracts/mount-context.js";
import {
  sameMcpServer,
  sameUnorderedStrings,
} from "./comparison.js";

/** Verifies resolved MCP contracts and current-device wrapper content. */
export class MountMcpServersInspector {
  constructor(
    private readonly context: MountContext,
    private readonly manifest: MountManifest,
    private readonly builtServers: BuiltMcpServer[],
  ) {}

  /** Reads each wrapper once and checks both persisted and canonical content. */
  inspect(): string | undefined {
    const persistedServers = this.manifest.mcpServers;
    if (!Array.isArray(persistedServers)) return "MCP server inventory is not an array";
    if (!sameUnorderedStrings(
      persistedServers.map((server) => server.name),
      this.builtServers.map(({ server }) => server.name),
    )) {
      return "MCP server inventory changed";
    }
    if (!sameUnorderedStrings(
      readdirSync(join(this.context.mountRoot, "mcp")),
      this.builtServers.map(({ server }) => server.name),
    )) {
      return "MCP server layout changed";
    }

    for (const built of this.builtServers) {
      const relativeWrapperPath = relative(this.context.mountRoot, built.server.wrapperPath);
      const expectedServer = {
        ...built.server,
        wrapperPath: relativeWrapperPath,
      };
      const persisted = persistedServers.find((server) => server.name === built.server.name);
      if (!persisted) return `MCP server contract missing: ${built.server.name}`;
      if (!sameMcpServer(persisted, expectedServer)) {
        return `MCP server contract changed: ${built.server.name}`;
      }

      const generated = this.manifest.generatedFiles.find(
        (candidate) => candidate.path === relativeWrapperPath,
      );
      if (!generated) return `MCP wrapper missing from manifest: ${built.server.name}`;
      const stat = lstatSync(built.server.wrapperPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return `MCP wrapper is invalid: ${built.server.name}`;
      }
      if ((stat.mode & 0o111) === 0) {
        return `MCP wrapper is not executable: ${built.server.name}`;
      }
      const content = readFileSync(built.server.wrapperPath, "utf8");
      if (sha256Text(content) !== generated.hash) {
        return `MCP wrapper hash changed: ${built.server.name}`;
      }
      if (content !== built.wrapperContent) {
        return `MCP wrapper changed for current device: ${built.server.name}`;
      }
    }
    return undefined;
  }
}

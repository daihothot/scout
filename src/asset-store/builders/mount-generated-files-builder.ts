import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { MountContext } from "../contracts/mount-context.js";
import type { MaterializedMcpServer } from "../contracts/resources.js";
import { CodexConfigBuilder } from "./codex-config-builder.js";

/** Canonical text for one non-wrapper file generated inside a mount. */
export interface BuiltMountGeneratedFile {
  path: string;
  content: string;
}

/**
 * Builds every non-wrapper generated file from the same immutable context used
 * by materialization and reuse inspection. It never reads or writes mount state.
 */
export class MountGeneratedFilesBuilder {
  constructor(
    private readonly context: MountContext,
    private readonly baseConfig: string,
    private readonly mcpServers: MaterializedMcpServer[],
  ) {}

  /** Returns the complete canonical generated-file projection in write order. */
  build(): BuiltMountGeneratedFile[] {
    const context = this.context;
    const pluginNames = context.profiledPluginPaths.map((path) => basename(path));
    const nativeHookCommand = [
      process.execPath,
      join(context.scoutRoot, "dist", "src", "agent-server", "codex", "codex-native-hook.js"),
      "--run-id",
      context.runId,
      "--agent-id",
      context.agentId,
      "--state-root",
      context.tempRoot,
    ].map(quoteShellArgument).join(" ");
    return [
      {
        path: ".codex/config.toml",
        content: new CodexConfigBuilder({
          baseConfig: this.baseConfig,
          mountRoot: context.mountRoot,
          runRoot: context.runRoot,
          artifactRoot: context.artifactRoot,
          tempRoot: context.tempRoot,
          hostTempRoot: tmpdir(),
          runId: context.runId,
          assetCommitId: context.assetCommitId,
          mcpServers: this.mcpServers,
        }).build(),
      },
      {
        path: ".codex/hooks.json",
        content: renderJson({
          hooks: {
            PreToolUse: [
              {
                matcher: "^Bash$",
                hooks: [
                  {
                    type: "command",
                    command: nativeHookCommand,
                    async: false,
                    timeout: 5,
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: "^Bash$",
                hooks: [
                  {
                    type: "command",
                    command: nativeHookCommand,
                    async: false,
                    timeout: 5,
                  },
                ],
              },
            ],
          },
        }),
      },
      {
        path: ".agents/plugins/marketplace.json",
        content: renderJson({
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
        }),
      },
    ];
  }
}

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

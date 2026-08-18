import type { MaterializedMcpServer } from "../contracts/resources.js";
import { buildMountShellEnvironment, buildMountShellPath } from "../mount/macros.js";

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

/** Renders the canonical mount-local Codex config without writing it. */
export class CodexConfigBuilder {
  constructor(private readonly input: GenerateCodexConfigOptions) {}

  build(): string {
    const input = this.input;
    const lines = [
      input.baseConfig.trimEnd(),
      "",
      "[shell_environment_policy.set]",
      `PATH = "${escapeToml(buildMountShellPath(input.mountRoot))}"`,
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
      if (server.cwd) lines.push(`cwd = "${escapeToml(server.cwd)}"`);
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
}

/** Convenience entry point retained for callers that only need rendered text. */
export function generateCodexConfig(input: GenerateCodexConfigOptions): string {
  return new CodexConfigBuilder(input).build();
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

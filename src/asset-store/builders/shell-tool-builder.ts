import { join } from "node:path";
import type {
  MountMaterializationIssue,
} from "../contracts/mount.js";
import type { ShellToolContract } from "../contracts/resources.js";
import { resolveAssetArg } from "../files/asset-paths.js";
import { resolveShellToolCommand } from "../files/command-resolution.js";

/** Canonical current-device wrapper projection for one resolved shell tool. */
export interface BuiltShellTool {
  contract: ShellToolContract;
  wrapperPath: string;
  command: string;
  args: string[];
  wrapperContent: string;
}

/** Resolved shell wrappers plus issues for contracts unavailable on this device. */
export interface ShellToolBuildResult {
  tools: BuiltShellTool[];
  issues: MountMaterializationIssue[];
}

/** Resolves shell contracts and renders wrappers without touching the mount filesystem. */
export class ShellToolBuilder {
  constructor(
    private readonly mountRoot: string,
    private readonly assetsRoot: string,
  ) {}

  build(contracts: ShellToolContract[]): ShellToolBuildResult {
    const tools: BuiltShellTool[] = [];
    const issues: MountMaterializationIssue[] = [];
    for (const contract of contracts) {
      const command = resolveShellToolCommand(contract, this.assetsRoot);
      if (!command) {
        issues.push({
          severity: contract.required ? "error" : "warning",
          code: "shell_tool_unresolved",
          message: `Shell tool command could not be resolved: ${contract.id} (${contract.command})`,
          resourceId: contract.id,
          detail: {
            name: contract.name,
            command: contract.command,
            exposeAs: contract.exposeAs,
            required: contract.required,
          },
        });
        continue;
      }
      const args = (contract.args ?? []).map((argument) =>
        resolveAssetArg(argument, this.assetsRoot)
      );
      tools.push({
        contract,
        wrapperPath: join(this.mountRoot, "bin", contract.exposeAs),
        command,
        args,
        wrapperContent: [
          "#!/bin/sh",
          `exec ${JSON.stringify(command)} ${args.map((argument) => JSON.stringify(argument)).join(" ")} "$@"`,
          "",
        ].join("\n"),
      });
    }
    return { tools, issues };
  }
}

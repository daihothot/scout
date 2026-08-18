import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { sha256Text } from "../../core/fs.js";
import type { BuiltShellTool } from "../builders/shell-tool-builder.js";
import type { MountManifest } from "../contracts/manifest.js";
import type { MountContext } from "../contracts/mount-context.js";
import { sameUnorderedStrings } from "./comparison.js";

/** Verifies resolved shell contracts and current-device wrapper content. */
export class MountShellToolsInspector {
  constructor(
    private readonly context: MountContext,
    private readonly manifest: MountManifest,
    private readonly builtTools: BuiltShellTool[],
  ) {}

  /** Reads each wrapper once and checks both persisted and canonical content. */
  inspect(): string | undefined {
    const persistedTools = this.manifest.shellTools;
    if (!Array.isArray(persistedTools)) return "shell tool inventory is not an array";
    if (!sameUnorderedStrings(
      persistedTools.map((tool) => tool.id),
      this.builtTools.map((tool) => tool.contract.id),
    )) {
      return "shell tool inventory changed";
    }
    if (!sameUnorderedStrings(
      readdirSync(join(this.context.mountRoot, "bin")),
      this.builtTools.map((tool) => tool.contract.exposeAs),
    )) {
      return "shell tool layout changed";
    }

    for (const built of this.builtTools) {
      const contract = built.contract;
      const persisted = persistedTools.find((candidate) => candidate.id === contract.id);
      if (!persisted) return `shell tool contract missing: ${contract.id}`;
      const relativeWrapperPath = relative(this.context.mountRoot, built.wrapperPath);
      const smokeChanged = (persisted.smoke === undefined) !== (contract.smoke === undefined)
        || Boolean(persisted.smoke && contract.smoke && (
          persisted.smoke.scope !== contract.smoke.scope
          || persisted.smoke.marker !== contract.smoke.marker
          || persisted.smoke.managedCodebase !== contract.smoke.managedCodebase
          || persisted.smoke.args.length !== contract.smoke.args.length
          || persisted.smoke.args.some((argument, index) => argument !== contract.smoke?.args[index])
        ));
      if (persisted.exposeAs !== contract.exposeAs
        || persisted.wrapperPath !== relativeWrapperPath
        || persisted.command !== contract.command
        || persisted.required !== contract.required
        || smokeChanged) {
        return `shell tool contract changed: ${contract.id}`;
      }

      const generated = this.manifest.generatedFiles.find(
        (candidate) => candidate.path === relativeWrapperPath,
      );
      if (!generated) return `shell tool wrapper missing from manifest: ${contract.id}`;
      const stat = lstatSync(built.wrapperPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return `shell tool wrapper is invalid: ${contract.id}`;
      }
      if ((stat.mode & 0o111) === 0) {
        return `shell tool wrapper is not executable: ${contract.id}`;
      }
      const content = readFileSync(built.wrapperPath, "utf8");
      if (sha256Text(content) !== generated.hash) {
        return `shell tool wrapper hash changed: ${contract.id}`;
      }
      if (content !== built.wrapperContent) {
        return `shell tool wrapper changed for current device: ${contract.id}`;
      }
    }
    return undefined;
  }
}

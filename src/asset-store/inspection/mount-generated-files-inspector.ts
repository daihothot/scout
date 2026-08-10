import {
  lstatSync,
  readFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { sha256Text } from "../../core/fs.js";
import { isPathWithin } from "../../core/path.js";
import type { BuiltMcpServer } from "../builders/mcp-server-builder.js";
import type { BuiltMountGeneratedFile } from "../builders/mount-generated-files-builder.js";
import type { BuiltShellTool } from "../builders/shell-tool-builder.js";
import type { MountManifest } from "../contracts/manifest.js";
import type { MountContext } from "../contracts/mount-context.js";

/** Verifies the generated-file inventory and non-wrapper generated content. */
export class MountGeneratedFilesInspector {
  constructor(
    private readonly context: MountContext,
    private readonly manifest: MountManifest,
    private readonly generatedFiles: readonly BuiltMountGeneratedFile[],
    private readonly shellTools: readonly BuiltShellTool[],
    private readonly mcpServers: readonly BuiltMcpServer[],
  ) {}

  /** Returns the first inventory, filesystem, persisted-hash, or config mismatch. */
  inspect(): string | undefined {
    if (!Array.isArray(this.manifest.generatedFiles)) {
      return "generated file inventory is not an array";
    }

    const expectedPaths = this.expectedPaths();
    const expectedPathSet = new Set(expectedPaths);
    const persistedByPath = new Map<string, MountManifest["generatedFiles"][number]>();
    for (const generated of this.manifest.generatedFiles) {
      if (persistedByPath.has(generated.path)) {
        return `duplicate generated file: ${generated.path}`;
      }
      persistedByPath.set(generated.path, generated);
    }
    if (persistedByPath.size !== expectedPaths.length) {
      const unexpected = [...persistedByPath.keys()].find((path) => !expectedPathSet.has(path));
      return unexpected
        ? `unexpected generated file: ${unexpected}`
        : "generated file inventory count changed";
    }
    for (const expectedPath of expectedPaths) {
      if (!persistedByPath.has(expectedPath)) {
        return `generated file missing from manifest: ${expectedPath}`;
      }
    }

    for (const expected of this.generatedFiles) {
      const relativePath = expected.path;
      const persisted = persistedByPath.get(relativePath)!;
      const path = resolve(this.context.mountRoot, relativePath);
      if (!isPathWithin(this.context.mountRoot, path)) {
        return `generated file path escapes mount root: ${relativePath}`;
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return `generated file is invalid: ${relativePath}`;
      }
      const content = readFileSync(path, "utf8");
      if (content !== expected.content) {
        return relativePath === ".codex/config.toml"
          ? describeConfigMismatch(content, expected.content)
          : `generated file changed from canonical content: ${relativePath}`;
      }
      if (sha256Text(content) !== persisted.hash) {
        return `generated file changed: ${relativePath}`;
      }
    }
    return undefined;
  }

  private expectedPaths(): string[] {
    return [
      ...this.generatedFiles.map((file) => file.path),
      ...this.shellTools.map((tool) => relative(this.context.mountRoot, tool.wrapperPath)),
      ...this.mcpServers.map(({ server }) => relative(this.context.mountRoot, server.wrapperPath)),
    ];
  }
}

function describeConfigMismatch(actual: string, expected: string): string {
  const actualAssignments = parseTomlAssignments(actual);
  const expectedAssignments = parseTomlAssignments(expected);
  const expectedEntries = [...expectedAssignments.entries()];
  const shellEnvironmentEntries = expectedEntries.filter(([key]) =>
    key.startsWith("shell_environment_policy.set.")
  );
  const otherEntries = expectedEntries.filter(([key]) =>
    !key.startsWith("shell_environment_policy.set.")
  );
  for (const [key, expectedValue] of [...shellEnvironmentEntries, ...otherEntries]) {
    if (actualAssignments.get(key) !== expectedValue) {
      const field = key.split(".").at(-1) ?? key;
      return `config value changed: ${field} (expected current mount path or runtime identity)`;
    }
  }
  return "generated file changed: .codex/config.toml";
}

function parseTomlAssignments(config: string): Map<string, string> {
  const assignments = new Map<string, string>();
  let section = "";
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = /^\[([^\]]+)]$/.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/.exec(trimmed);
    if (assignment) assignments.set(`${section}.${assignment[1]}`, assignment[2]!);
  }
  return assignments;
}

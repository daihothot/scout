import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellToolsFile } from "../../src/asset-store/index.js";

const repoRoot = process.cwd();

export function createCodexAssetFixture(
  prefix: string,
  options: { stubExternalShellTools?: boolean } = {},
): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "assets", "codex"), join(fixtureRoot, "assets", "codex"), {
    recursive: true,
  });
  if (options.stubExternalShellTools !== false) {
    stubExternalShellTools(join(fixtureRoot, "assets", "codex"));
  }
  return fixtureRoot;
}

export function stubExternalShellTools(assetsRoot: string): void {
  const stubsDir = join(assetsRoot, "tools", "local-stubs");
  mkdirSync(stubsDir, { recursive: true });
  writeExecutable(
    join(stubsDir, "jarvis"),
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"codebase\" ] && [ \"$2\" = \"supported\" ]; then",
      "  printf '%s\\n' gurusdk-unity",
      "  exit 0",
      "fi",
      "printf '%s\\n' gurusdk-unity",
      "",
    ].join("\n"),
  );
  writeExecutable(
    join(stubsDir, "codegraph"),
    [
      "#!/bin/sh",
      "printf '%s\\n' 'codegraph 0.0.0-test'",
      "",
    ].join("\n"),
  );

  const shellToolsPath = join(assetsRoot, "tools", "shell-tools.json");
  const shellTools = JSON.parse(readFileSync(shellToolsPath, "utf8")) as ShellToolsFile;
  for (const tool of shellTools.tools) {
    if (tool.id === "jarvis") {
      tool.command = "assets/codex/tools/local-stubs/jarvis";
    }
    if (tool.id === "codegraph") {
      tool.command = "assets/codex/tools/local-stubs/codegraph";
    }
  }
  writeFileSync(shellToolsPath, `${JSON.stringify(shellTools, null, 2)}\n`, "utf8");
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

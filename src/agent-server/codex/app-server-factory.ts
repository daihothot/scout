import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CodexAppServerClient } from "./app-server-client.js";

/** Filesystem, provider, and root settings used to launch one isolated app-server. */
export interface CreateCodexAppServerClientOptions {
  isolatedHome: string;
  isolatedCodexHome: string;
  configToml: string;
  logPrefix: string;
  providerName: string;
  providerApiKey?: string;
  stderrLogPath: string;
  transportLogPath?: string;
  mountRoots?: string[];
}

/** Client plus the isolated paths and effective roots needed by run stages. */
export interface CodexAppServerClientBundle {
  client: CodexAppServerClient;
  codexPath: string;
  codexVersion: string;
  isolatedHome: string;
  isolatedCodexHome: string;
  mountRoots: string[];
}

/** Writes the isolated Codex config and constructs the corresponding protocol client. */
export function createCodexAppServerClient(options: CreateCodexAppServerClientOptions): CodexAppServerClientBundle {
  const packageJsonPath = createRequire(import.meta.url).resolve("@openai/codex/package.json");
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
    throw new Error(`Invalid Scout Codex package metadata at ${packageJsonPath}.`);
  }
  const packageFields = packageJson as Record<string, unknown>;
  const bin = packageFields.bin;
  const codexBin = typeof bin === "object" && bin !== null && !Array.isArray(bin)
    ? (bin as Record<string, unknown>).codex
    : undefined;
  if (typeof packageFields.version !== "string" || typeof codexBin !== "string") {
    throw new Error(`Scout Codex package metadata is missing version or bin.codex at ${packageJsonPath}.`);
  }
  const codexVersion = packageFields.version;
  const codexPath = join(dirname(packageJsonPath), codexBin);
  writeFileSync(
    join(options.isolatedCodexHome, "config.toml"),
    options.configToml,
    "utf8",
  );
  return {
    client: new CodexAppServerClient({
      // CODEX_HOME isolates Codex state. HOME remains the current device's
      // real home so third-party tools resolve ~/.guru and ~/.codegraph correctly.
      home: homedir(),
      codexHome: options.isolatedCodexHome,
      providerName: options.providerName,
      providerApiKey: options.providerApiKey,
      codexPath,
      expectedCodexVersion: codexVersion,
      logPrefix: options.logPrefix,
      stderrLogPath: options.stderrLogPath,
      transportLogPath: options.transportLogPath,
    }),
    codexPath,
    codexVersion,
    isolatedHome: options.isolatedHome,
    isolatedCodexHome: options.isolatedCodexHome,
    mountRoots: options.mountRoots ?? [],
  };
}

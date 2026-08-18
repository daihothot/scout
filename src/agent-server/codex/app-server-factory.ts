import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  isolatedHome: string;
  isolatedCodexHome: string;
  mountRoots: string[];
}

/** Writes the isolated Codex config and constructs the corresponding protocol client. */
export function createCodexAppServerClient(options: CreateCodexAppServerClientOptions): CodexAppServerClientBundle {
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
      logPrefix: options.logPrefix,
      stderrLogPath: options.stderrLogPath,
      transportLogPath: options.transportLogPath,
    }),
    isolatedHome: options.isolatedHome,
    isolatedCodexHome: options.isolatedCodexHome,
    mountRoots: options.mountRoots ?? [],
  };
}

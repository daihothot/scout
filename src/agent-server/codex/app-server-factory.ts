import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServerClient } from "./app-server-client.js";

export interface CreateCodexAppServerClientOptions {
  isolatedHome: string;
  isolatedCodexHome: string;
  configToml: string;
  logPrefix: string;
  defaultWritableRoots?: string[];
  mountRoots?: string[];
  trustedRoots?: string[];
}

export interface CodexAppServerClientBundle {
  client: CodexAppServerClient;
  isolatedHome: string;
  isolatedCodexHome: string;
  defaultWritableRoots: string[];
  mountRoots: string[];
  trustedRoots: string[];
}

export function createCodexAppServerClient(options: CreateCodexAppServerClientOptions): CodexAppServerClientBundle {
  writeFileSync(
    join(options.isolatedCodexHome, "config.toml"),
    options.configToml,
    "utf8",
  );
  return {
    client: new CodexAppServerClient({
      home: options.isolatedHome,
      codexHome: options.isolatedCodexHome,
      logPrefix: options.logPrefix,
    }),
    isolatedHome: options.isolatedHome,
    isolatedCodexHome: options.isolatedCodexHome,
    defaultWritableRoots: options.defaultWritableRoots ?? [],
    mountRoots: options.mountRoots ?? [],
    trustedRoots: options.trustedRoots ?? [],
  };
}

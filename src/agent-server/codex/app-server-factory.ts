import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAppServerClient } from "./app-server-client.js";

export interface CreateCodexAppServerClientOptions {
  mountRoot: string;
  trustedRoots?: string[];
  writableRoots?: string[];
  tempPrefix: string;
  logPrefix: string;
}

export interface CodexAppServerClientBundle {
  client: CodexAppServerClient;
  isolatedHome: string;
  isolatedCodexHome: string;
  defaultWritableRoots: string[];
}

export function createCodexAppServerClient(options: CreateCodexAppServerClientOptions): CodexAppServerClientBundle {
  const mountRoot = resolve(options.mountRoot);
  const trustedRoots = uniqueResolved(options.trustedRoots ?? []);
  const defaultWritableRoots = buildDefaultWritableRoots({
    mountRoot,
    writableRoots: options.writableRoots ?? [],
  });
  const isolatedHome = mkdtempSync(join(tmpdir(), options.tempPrefix));
  const isolatedCodexHome = join(isolatedHome, ".codex");
  mkdirSync(isolatedCodexHome, { recursive: true });
  writeFileSync(
    join(isolatedCodexHome, "config.toml"),
    buildIsolatedConfig({
      mountRoots: [mountRoot],
      trustedRoots,
    }),
    "utf8",
  );
  return {
    client: new CodexAppServerClient({
      home: isolatedHome,
      codexHome: isolatedCodexHome,
      logPrefix: options.logPrefix,
    }),
    isolatedHome,
    isolatedCodexHome,
    defaultWritableRoots,
  };
}

function buildDefaultWritableRoots(input: {
  mountRoot: string;
  writableRoots: string[];
}): string[] {
  const roots = [
    input.mountRoot,
    resolve(input.mountRoot, "..", "artifacts"),
    ...input.writableRoots,
  ];
  return uniqueResolved(roots);
}

function buildIsolatedConfig(input: { mountRoots: string[]; trustedRoots: string[] }): string {
  const homeConfig = readHomeProviderConfig();
  const mountRoots = uniqueResolved(input.mountRoots);
  const trustedRoots = uniqueResolved(input.trustedRoots);
  const lines = [
    'model = "gpt-5.4-mini"',
    'model_provider = "GuruOpenAI"',
    "",
    "[features]",
    "shell_snapshot = false",
    "",
    "[model_providers.GuruOpenAI]",
    'name = "GuruOpenAI"',
    `base_url = "${escapeToml(homeConfig.baseUrl ?? "https://api.openai.com/v1")}"`,
    `env_key = "${escapeToml(homeConfig.envKey ?? "OPENAI_API_KEY")}"`,
    'wire_api = "responses"',
    "",
  ];
  for (const mountRoot of mountRoots) {
    lines.push(
      `[projects."${escapeToml(mountRoot)}"]`,
      'trust_level = "trusted"',
      "",
    );
  }
  for (const trustedRoot of trustedRoots) {
    if (mountRoots.includes(resolve(trustedRoot))) continue;
    lines.push(
      `[projects."${escapeToml(resolve(trustedRoot))}"]`,
      'trust_level = "trusted"',
      "",
    );
  }
  return lines.join("\n");
}

function uniqueResolved(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))];
}

function readHomeProviderConfig(): { baseUrl?: string; envKey?: string } {
  try {
    const text = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const block = text.match(/^\[model_providers\.GuruOpenAI\]\n([\s\S]*?)(?=^\[|\z)/m)?.[1] ?? "";
    return {
      baseUrl: block.match(/^base_url\s*=\s*"([^"]*)"/m)?.[1],
      envKey: block.match(/^env_key\s*=\s*"([^"]*)"/m)?.[1],
    };
  } catch {
    return {};
  }
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

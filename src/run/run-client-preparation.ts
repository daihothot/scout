import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createCodexAppServerClient,
  type CodexAppServerClientBundle,
  type CreateCodexAppServerClientOptions,
} from "../agent-server/codex/app-server-factory.js";
import { CodexAssetLayout } from "../asset-store/asset-layout.js";
import {
  type AgentProfile,
  type AgentProfilesFile,
  type McpServersFile,
} from "../asset-store/types.js";
import { readJsonFile } from "../core/fs.js";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../agent/thread/types.js";
import {
  buildMountMacroValues,
  resolveMountMacros,
} from "../asset-store/mount-macros.js";

export const RunClientAgentRoles = [
  ScoutAgentRoles.Coordinator,
  ScoutAgentRoles.Researcher,
  ScoutAgentRoles.Verifier,
  ScoutAgentRoles.Validator,
] as const;

export interface RunClientRootPlan {
  mountRoots: string[];
  trustedRoots: string[];
  writableRoots: string[];
  defaultWritableRoots: string[];
}

export interface PreparedRunClients {
  appServerClient: CodexAppServerClientBundle;
  rootPlan: RunClientRootPlan;
}

export interface PrepareRunClientsOptions {
  repoRoot: string;
  runId: string;
  agentRoles?: readonly ScoutAgentRole[];
  createAppServerClient?: (options: CreateCodexAppServerClientOptions & {
    rootPlan: RunClientRootPlan;
  }) => CodexAppServerClientBundle;
}

export async function prepareRunClients(options: PrepareRunClientsOptions): Promise<PreparedRunClients> {
  const rootPlan = buildRunClientRootPlan(options);
  const isolatedHome = join(resolve(options.repoRoot), "run", options.runId, "codex-home");
  const isolatedCodexHome = join(isolatedHome, ".codex");
  mkdirSync(isolatedCodexHome, { recursive: true });
  const configToml = buildRunClientConfig({
    mountRoots: rootPlan.mountRoots,
    trustedRoots: rootPlan.trustedRoots,
  });
  const clientOptions = {
    isolatedHome,
    isolatedCodexHome,
    configToml,
    logPrefix: `scout ${options.runId} app-server`,
    defaultWritableRoots: rootPlan.defaultWritableRoots,
    mountRoots: rootPlan.mountRoots,
    trustedRoots: rootPlan.trustedRoots,
    rootPlan,
  };
  const appServerClient = options.createAppServerClient
    ? options.createAppServerClient(clientOptions)
    : createCodexAppServerClient(clientOptions);
  await appServerClient.client.startSession();
  return {
    appServerClient,
    rootPlan,
  };
}

export function buildRunClientRootPlan(options: {
  repoRoot: string;
  runId: string;
  agentRoles?: readonly ScoutAgentRole[];
}): RunClientRootPlan {
  const repoRoot = resolve(options.repoRoot);
  const runRoot = join(repoRoot, "run", options.runId);
  const assetsRoot = join(repoRoot, "assets", "codex");
  const profiles = readJsonFile<AgentProfilesFile>(join(assetsRoot, CodexAssetLayout.agentProfiles));
  const mcpServers = readJsonFile<McpServersFile>(join(assetsRoot, CodexAssetLayout.mcpServers));
  const agentRoles = options.agentRoles ?? RunClientAgentRoles;
  const mountRoots: string[] = [];
  const trustedRoots: string[] = [];
  const writableRoots: string[] = [];

  for (const role of agentRoles) {
    const profile = requireProfile(profiles, role);
    const agentRoot = join(runRoot, "agents", role);
    const mountRoot = join(agentRoot, "mount");
    const artifactRoot = join(agentRoot, "artifacts");
    mountRoots.push(mountRoot);
    trustedRoots.push(...resolveProfileRoots({
      roots: profile.trustedRoots,
      repoRoot,
      runRoot,
      mountRoot,
      artifactRoot,
    }));
    writableRoots.push(...resolveProfileRoots({
      roots: profile.writableRoots,
      repoRoot,
      runRoot,
      mountRoot,
      artifactRoot,
    }));
    const dynamicValues = buildMountMacroValues({
      repoRoot,
      runRoot,
      mountRoot,
      artifactRoot,
      assetCommitId: "",
      runId: options.runId,
    });
    for (const serverName of profile.mcpServers) {
      const server = mcpServers.servers[serverName];
      if (!server) throw new Error(`Agent profile references unknown MCP server: ${serverName}`);
      trustedRoots.push(...resolveDynamicRoots(server.trustedRoots, dynamicValues));
      writableRoots.push(...resolveDynamicRoots(server.writableRoots, dynamicValues));
    }
  }

  const uniqueMountRoots = uniqueResolved(mountRoots);
  const uniqueTrustedRoots = uniqueResolved(trustedRoots);
  const uniqueWritableRoots = uniqueResolved(writableRoots);
  return {
    mountRoots: uniqueMountRoots,
    trustedRoots: uniqueTrustedRoots,
    writableRoots: uniqueWritableRoots,
    defaultWritableRoots: uniqueResolved([
      ...uniqueMountRoots,
      ...uniqueMountRoots.map((mountRoot) => resolve(mountRoot, "..", "artifacts")),
      ...uniqueWritableRoots,
    ]),
  };
}

export function buildRunClientConfig(input: {
  mountRoots: string[];
  trustedRoots: string[];
}): string {
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
    if (mountRoots.includes(trustedRoot)) continue;
    lines.push(
      `[projects."${escapeToml(trustedRoot)}"]`,
      'trust_level = "trusted"',
      "",
    );
  }
  return lines.join("\n");
}

function requireProfile(profiles: AgentProfilesFile, role: ScoutAgentRole): AgentProfile {
  const profile = profiles.profiles[role];
  if (!profile) throw new Error(`No agent profile configured for agent: ${role}`);
  return profile;
}

function resolveProfileRoots(input: {
  roots?: string[];
  repoRoot: string;
  runRoot: string;
  mountRoot: string;
  artifactRoot: string;
}): string[] {
  const dynamicValues = buildMountMacroValues({
    repoRoot: input.repoRoot,
    runRoot: input.runRoot,
    mountRoot: input.mountRoot,
    artifactRoot: input.artifactRoot,
    assetCommitId: "",
  });
  return (input.roots ?? [])
    .map((root) => resolveMountMacros(root, dynamicValues))
    .filter((root) => root.length > 0)
    .map((root) => resolveProfileRoot(root, input.repoRoot));
}

function resolveDynamicRoots(
  roots: string[] | undefined,
  dynamicValues: Record<string, string | undefined>,
): string[] {
  return (roots ?? [])
    .map((root) => resolveMountMacros(root, dynamicValues))
    .filter((root) => root.length > 0)
    .map((root) => resolve(root));
}

function resolveProfileRoot(root: string, repoRoot: string): string {
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return resolve(homedir(), root.slice(2));
  if (isAbsolute(root)) return root;
  return resolve(repoRoot, root);
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

function uniqueResolved(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].sort();
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

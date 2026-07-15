import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createCodexAppServerClient,
  type CodexAppServerClientBundle,
  type CreateCodexAppServerClientOptions,
} from "../../../agent-server/codex/app-server-factory.js";
import {
  resolveDefaultAgentModel,
  readAgentProfilesForRepo,
  resolveAgentProfile,
} from "../../../asset-store/agent-profiles.js";
import { CodexAssetLayout } from "../../../asset-store/asset-layout.js";
import {
  buildMountMacroValues,
  resolveMountMacros,
} from "../../../asset-store/mount-macros.js";
import type { McpServersFile } from "../../../asset-store/types.js";
import {
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../../agent/thread/types.js";
import type { CodexModelConfig } from "../../../agent-server/codex/model-config.js";
import { readJsonFile } from "../../../core/fs.js";
import { currentRunScope } from "../../run-scope.js";
import type { BootStage } from "../boot-stage.js";

export interface BootClientRootPlan {
  mountRoots: string[];
  trustedRoots: string[];
  writableRoots: string[];
  defaultWritableRoots: string[];
}

export interface BootClientsStageOptions {
  agentRoles?: readonly ScoutAgentRole[];
  createAppServerClient?: (options: CreateCodexAppServerClientOptions & {
    rootPlan: BootClientRootPlan;
  }) => CodexAppServerClientBundle;
}

export class BootClientsStage implements BootStage {
  readonly id = "clients";
  private readonly options: BootClientsStageOptions;
  private clientBundle?: CodexAppServerClientBundle;
  private clientRootPlan?: BootClientRootPlan;
  private stopped = false;

  constructor(options: BootClientsStageOptions = {}) {
    this.options = options;
  }

  get appServerClient(): CodexAppServerClientBundle {
    if (!this.clientBundle) throw new Error("Boot clients stage has not completed.");
    return this.clientBundle;
  }

  get rootPlan(): BootClientRootPlan {
    if (!this.clientRootPlan) throw new Error("Boot clients stage has not completed.");
    return this.clientRootPlan;
  }

  async start(): Promise<void> {
    const scope = currentRunScope();
    const rootPlan = buildClientRootPlan({
      repoRoot: scope.repoRoot,
      runId: scope.runId,
      agentRoles: this.options.agentRoles,
    });
    const defaultModel = resolveDefaultAgentModel(readAgentProfilesForRepo(scope.repoRoot));
    const runRoot = join(resolve(scope.repoRoot), "run", scope.runId);
    const logsRoot = join(runRoot, "logs");
    const isolatedHome = join(runRoot, "codex-home");
    const isolatedCodexHome = join(isolatedHome, ".codex");
    mkdirSync(isolatedCodexHome, { recursive: true });
    const configToml = buildClientConfig({
      mountRoots: rootPlan.mountRoots,
      trustedRoots: rootPlan.trustedRoots,
      model: defaultModel,
    });
    const clientOptions = {
      isolatedHome,
      isolatedCodexHome,
      configToml,
      providerName: defaultModel.provider,
      logPrefix: `scout ${scope.runId} app-server`,
      stderrLogPath: join(logsRoot, "app-server.log"),
      transportLogPath: process.env.SCOUT_APP_SERVER_TRACE === "1"
        ? join(logsRoot, "app-server.ndjson")
        : undefined,
      defaultWritableRoots: rootPlan.defaultWritableRoots,
      mountRoots: rootPlan.mountRoots,
      trustedRoots: rootPlan.trustedRoots,
      rootPlan,
    };
    const clientBundle = this.options.createAppServerClient
      ? this.options.createAppServerClient(clientOptions)
      : createCodexAppServerClient(clientOptions);
    try {
      await clientBundle.client.startSession();
      scope.setAppServer(clientBundle.client);
    } catch (error) {
      clientBundle.client.close();
      throw error;
    }
    this.clientRootPlan = rootPlan;
    this.clientBundle = clientBundle;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const client = this.clientBundle?.client;
    if (!client) return;
    try {
      client.close();
    } finally {
      currentRunScope().clearAppServer(client);
    }
  }
}

function buildClientRootPlan(options: {
  repoRoot: string;
  runId: string;
  agentRoles?: readonly ScoutAgentRole[];
}): BootClientRootPlan {
  const repoRoot = resolve(options.repoRoot);
  const runRoot = join(repoRoot, "run", options.runId);
  const assetsRoot = join(repoRoot, "assets", "codex");
  const profiles = readAgentProfilesForRepo(repoRoot);
  const mcpServers = readJsonFile<McpServersFile>(join(assetsRoot, CodexAssetLayout.mcpServers));
  const agentRoles = options.agentRoles ?? Object.values(ScoutAgentRoles);
  const mountRoots: string[] = [];
  const trustedRoots: string[] = [];
  const writableRoots: string[] = [];

  for (const role of agentRoles) {
    const profile = resolveAgentProfile(profiles, role);
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

function buildClientConfig(input: {
  mountRoots: string[];
  trustedRoots: string[];
  model: CodexModelConfig;
}): string {
  const homeConfig = readHomeProviderConfig(input.model.provider);
  const mountRoots = uniqueResolved(input.mountRoots);
  const trustedRoots = uniqueResolved(input.trustedRoots);
  const lines = [
    `model = "${escapeToml(input.model.id)}"`,
    `model_provider = "${escapeToml(input.model.provider)}"`,
    `model_reasoning_effort = "${input.model.reasoningEffort}"`,
    `model_reasoning_summary = "${input.model.reasoningSummary}"`,
    "",
    "[features]",
    "shell_snapshot = false",
    "",
    `[model_providers.${input.model.provider}]`,
    `name = "${escapeToml(input.model.provider)}"`,
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

function readHomeProviderConfig(providerName: string): { baseUrl?: string; envKey?: string } {
  try {
    const text = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const escapedProvider = providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = text.match(new RegExp(
      `^\\[model_providers\\.${escapedProvider}\\]\\n([\\s\\S]*?)(?=^\\[|\\z)`,
      "m",
    ))?.[1] ?? "";
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
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

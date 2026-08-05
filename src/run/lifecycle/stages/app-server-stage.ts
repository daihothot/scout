import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createCodexAppServerClient,
  type CodexAppServerClientBundle,
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
import type { RunEnvironment } from "../../types.js";
import { readJsonFile } from "../../../core/fs.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

export interface RunAppServerRootPlan {
  mountRoots: string[];
  trustedRoots: string[];
  writableRoots: string[];
  defaultWritableRoots: string[];
}

export interface RunAppServerStageOptions {
  agentRoles?: readonly ScoutAgentRole[];
}

export class RunAppServerStage implements RunStage {
  readonly id = "clients";
  private readonly options: RunAppServerStageOptions;
  private clientBundle?: CodexAppServerClientBundle;
  private clientRootPlan?: RunAppServerRootPlan;
  private stopped = false;

  constructor(options: RunAppServerStageOptions = {}) {
    this.options = options;
  }

  get appServerClient(): CodexAppServerClientBundle {
    if (!this.clientBundle) throw new Error("Run app-server stage has not completed.");
    return this.clientBundle;
  }

  get rootPlan(): RunAppServerRootPlan {
    if (!this.clientRootPlan) throw new Error("Run app-server stage has not completed.");
    return this.clientRootPlan;
  }

  async start(): Promise<void> {
    const scope = currentRunScope();
    const rootPlan = scope.hasEnvironment
      ? buildPreparedClientRootPlan(scope.environment)
      : buildClientRootPlan({
        repoRoot: scope.repoRoot,
        runId: scope.runId,
        agentRoles: this.options.agentRoles,
      });
    const defaultModel = scope.hasEnvironment
      ? scope.environment.agents[ScoutAgentRoles.Coordinator].mount.agentProfile.model
      : resolveDefaultAgentModel(readAgentProfilesForRepo(scope.repoRoot));
    const runRoot = join(resolve(scope.repoRoot), "run", scope.runId);
    const logsRoot = join(runRoot, "logs");
    const isolatedHome = join(runRoot, "codex-home");
    const isolatedCodexHome = join(isolatedHome, ".codex");
    mkdirSync(isolatedCodexHome, { recursive: true });
    const providerConfig = readHomeProviderConfig(defaultModel.provider);
    rebindTargetCodexAuth(isolatedCodexHome, providerConfig.authPath);
    const configToml = buildClientConfig({
      mountRoots: rootPlan.mountRoots,
      trustedRoots: rootPlan.trustedRoots,
      model: defaultModel,
      providerConfig,
    });
    const clientOptions = {
      isolatedHome,
      isolatedCodexHome,
      configToml,
      providerName: defaultModel.provider,
      providerApiKey: providerConfig.experimentalBearerToken,
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
    const clientBundle = createCodexAppServerClient(clientOptions);
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
}): RunAppServerRootPlan {
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

function buildPreparedClientRootPlan(environment: RunEnvironment): RunAppServerRootPlan {
  const agents = Object.values(environment.agents);
  const mountRoots = uniqueResolved(environment.rootAccess.mountRoots);
  return {
    mountRoots,
    trustedRoots: uniqueResolved(environment.rootAccess.trustedRoots),
    writableRoots: uniqueResolved(environment.rootAccess.writableRoots),
    defaultWritableRoots: uniqueResolved([
      ...mountRoots,
      ...agents.map((agent) => agent.mount.artifactRoot),
      ...environment.rootAccess.writableRoots,
    ]),
  };
}

function buildClientConfig(input: {
  mountRoots: string[];
  trustedRoots: string[];
  model: CodexModelConfig;
  providerConfig: ReturnType<typeof readHomeProviderConfig>;
}): string {
  const homeConfig = input.providerConfig;
  const mountRoots = uniqueResolved(input.mountRoots);
  const trustedRoots = uniqueResolved(input.trustedRoots);
  const providerLines = [
    `[model_providers.${input.model.provider}]`,
    `name = "${escapeToml(input.model.provider)}"`,
    `base_url = "${escapeToml(homeConfig.baseUrl)}"`,
  ];
  if (homeConfig.requiresOpenaiAuth !== undefined) {
    providerLines.push(`requires_openai_auth = ${homeConfig.requiresOpenaiAuth}`);
  }
  const providerEnvKey = homeConfig.experimentalBearerToken
    ? "CODEX_API_KEY"
    : homeConfig.envKey;
  if (providerEnvKey) {
    providerLines.push(`env_key = "${escapeToml(providerEnvKey)}"`);
  }
  providerLines.push(
    `wire_api = "${escapeToml(homeConfig.wireApi ?? "responses")}"`,
    "",
  );
  const lines = [
    `model = "${escapeToml(input.model.id)}"`,
    `model_provider = "${escapeToml(input.model.provider)}"`,
    `model_reasoning_effort = "${input.model.reasoningEffort}"`,
    `model_reasoning_summary = "${input.model.reasoningSummary}"`,
    "",
    "[features]",
    "shell_snapshot = false",
    "",
    ...providerLines,
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

function readHomeProviderConfig(providerName: string): {
  baseUrl: string;
  envKey?: string;
  experimentalBearerToken?: string;
  requiresOpenaiAuth?: boolean;
  wireApi?: string;
  authPath?: string;
} {
  const codexHome = join(homedir(), ".codex");
  const configPath = join(codexHome, "config.toml");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read Codex config for model provider "${providerName}" at ${configPath}.`,
      { cause: error },
    );
  }

  const block = readTomlTableBlock(text, `model_providers.${providerName}`);
  if (block.trim().length === 0) {
    throw new Error(
      `Codex model provider "${providerName}" is not configured in ${configPath}.`,
    );
  }

  const baseUrl = block.match(/^base_url\s*=\s*"([^"]*)"/m)?.[1]?.trim();
  if (!baseUrl) {
    throw new Error(
      `Codex model provider "${providerName}" must define a non-empty base_url.`,
    );
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error(
      `Codex model provider "${providerName}" has an invalid base_url.`,
    );
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error(
      `Codex model provider "${providerName}" base_url must use http or https.`,
    );
  }

  const envKeyMatch = block.match(/^env_key\s*=\s*"([^"]*)"/m);
  const envKey = envKeyMatch?.[1]?.trim();
  if (envKeyMatch && (!envKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey))) {
    throw new Error(
      `Codex model provider "${providerName}" has an invalid env_key.`,
    );
  }
  const bearerTokenMatch = block.match(
    /^experimental_bearer_token\s*=\s*"([^"]*)"/m,
  );
  const experimentalBearerToken = bearerTokenMatch?.[1];
  if (bearerTokenMatch && !experimentalBearerToken?.trim()) {
    throw new Error(
      `Codex model provider "${providerName}" has an empty experimental_bearer_token.`,
    );
  }
  const requiresOpenaiAuthAssignment = /^requires_openai_auth\s*=/m.test(block);
  const requiresOpenaiAuthValue = block.match(
    /^requires_openai_auth\s*=\s*(true|false)\s*(?:#.*)?$/m,
  )?.[1];
  if (requiresOpenaiAuthAssignment && requiresOpenaiAuthValue === undefined) {
    throw new Error(
      `Codex model provider "${providerName}" has an invalid requires_openai_auth value.`,
    );
  }
  const requiresOpenaiAuth = requiresOpenaiAuthValue === undefined
    ? undefined
    : requiresOpenaiAuthValue === "true";

  const hasConfiguredEnvironmentCredential = envKey !== undefined
    && Boolean(process.env[envKey]?.trim());
  const authPath = join(codexHome, "auth.json");
  const hasCodexAuth = requiresOpenaiAuth === true && (() => {
    try {
      const auth = JSON.parse(
        readFileSync(authPath, "utf8"),
      ) as unknown;
      if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return false;
      const authRecord = auth as Record<string, unknown>;
      if (typeof authRecord.OPENAI_API_KEY === "string"
        && authRecord.OPENAI_API_KEY.trim().length > 0) {
        return true;
      }
      const tokens = authRecord.tokens;
      return typeof tokens === "object"
        && tokens !== null
        && !Array.isArray(tokens)
        && typeof (tokens as Record<string, unknown>).access_token === "string"
        && ((tokens as Record<string, unknown>).access_token as string).trim().length > 0;
    } catch {
      return false;
    }
  })();
  if (!experimentalBearerToken?.trim()
    && !hasConfiguredEnvironmentCredential
    && !hasCodexAuth) {
    throw new Error(
      `Codex model provider "${providerName}" has no usable authentication. Configure a non-empty experimental_bearer_token, set the environment variable named by env_key, or provide usable Codex auth when requires_openai_auth is true.`,
    );
  }

  return {
    baseUrl,
    envKey,
    experimentalBearerToken,
    requiresOpenaiAuth,
    wireApi: block.match(/^wire_api\s*=\s*"([^"]*)"/m)?.[1],
    authPath: !experimentalBearerToken?.trim()
        && !hasConfiguredEnvironmentCredential
        && hasCodexAuth
      ? authPath
      : undefined,
  };
}

function rebindTargetCodexAuth(isolatedCodexHome: string, targetAuthPath?: string): void {
  const isolatedAuthPath = join(isolatedCodexHome, "auth.json");
  try {
    lstatSync(isolatedAuthPath);
    rmSync(isolatedAuthPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (targetAuthPath) symlinkSync(targetAuthPath, isolatedAuthPath);
}

function readTomlTableBlock(text: string, tableName: string): string {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = text.match(new RegExp(`^\\[${escaped}\\]\\r?\\n`, "m"));
  if (!header || header.index === undefined) return "";
  const contentStart = header.index + header[0].length;
  const rest = text.slice(contentStart);
  const nextHeader = rest.search(/\r?\n\[/);
  return nextHeader === -1 ? rest : rest.slice(0, nextHeader);
}

function uniqueResolved(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].sort();
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

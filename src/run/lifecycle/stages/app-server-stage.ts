import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  createCodexAppServerClient,
  type CodexAppServerClientBundle,
} from "../../../agent-server/codex/app-server-factory.js";
import {
  resolveDefaultAgentModel,
  readAgentProfilesForScoutRoot,
  resolveAgentProfile,
} from "../../../asset-store/assets/agent-profiles.js";
import {
  CodexAssetLayout,
  roleAgentPath,
} from "../../../asset-store/assets/asset-layout.js";
import {
  resolveAssetArg,
} from "../../../asset-store/files/asset-paths.js";
import {
  resolveShellToolCommand,
} from "../../../asset-store/files/command-resolution.js";
import {
  buildMountMacroValues,
  resolveMountMacros,
} from "../../../asset-store/mount/macros.js";
import type { AgentProfile } from "../../../asset-store/contracts/profile.js";
import type {
  McpServersFile,
  ShellToolContract,
  ShellToolsFile,
} from "../../../asset-store/contracts/resources.js";
import {
  ScoutAgentPermissionProfiles,
  ScoutAgentRoles,
  type ScoutAgentRole,
} from "../../../agent/thread/types.js";
import type { CodexModelConfig } from "../../../agent-server/codex/model-config.js";
import type { RunEnvironment } from "../../types.js";
import { readJsonFile } from "../../../core/fs.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Per-role local-command filesystem policy rendered into Codex config. */
export interface RunAgentPermissionPlan {
  id: string;
  mountRoot: string;
  readableRoots: string[];
  writableRoots: string[];
  deniedRoots: string[];
}

/** Run-wide diagnostics plus the role-owned authorization plans. */
export interface RunAppServerRootPlan {
  mountRoots: string[];
  readableRoots: string[];
  writableRoots: string[];
  permissionProfiles: Partial<Record<ScoutAgentRole, RunAgentPermissionPlan>>;
}

/** Optional role selection used when an environment is not yet prepared. */
export interface RunAppServerStageOptions {
  agentRoles?: readonly ScoutAgentRole[];
}

/**
 * Creates the per-run Codex app-server clients, isolated home, and config.
 * Mount/environment stages provide the facts; this stage only binds clients
 * and releases them during lifecycle shutdown.
 */
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
      ? buildPreparedClientRootPlan(scope.environment, scope.scoutRoot)
      : buildClientRootPlan({
        scoutRoot: scope.scoutRoot,
        runRoot: scope.runRoot,
        agentRoles: this.options.agentRoles,
      });
    const defaultModel = scope.hasEnvironment
      ? scope.environment.agents[ScoutAgentRoles.Coordinator].mount.agentProfile.model
      : resolveDefaultAgentModel(readAgentProfilesForScoutRoot(scope.scoutRoot));
    const runRoot = resolve(scope.runRoot);
    const logsRoot = join(runRoot, "logs");
    const isolatedHome = join(runRoot, "codex-home");
    const isolatedCodexHome = join(isolatedHome, ".codex");
    mkdirSync(isolatedCodexHome, { recursive: true });
    const providerConfig = readHomeProviderConfig(defaultModel.provider);
    rebindTargetCodexAuth(isolatedCodexHome, providerConfig.authPath);
    const configToml = buildClientConfig({
      mountRoots: rootPlan.mountRoots,
      permissionProfiles: rootPlan.permissionProfiles,
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
      mountRoots: rootPlan.mountRoots,
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
  scoutRoot: string;
  runRoot: string;
  agentRoles?: readonly ScoutAgentRole[];
}): RunAppServerRootPlan {
  const scoutRoot = resolve(options.scoutRoot);
  const runRoot = resolve(options.runRoot);
  const assetsRoot = join(scoutRoot, "assets", "codex");
  const profiles = readAgentProfilesForScoutRoot(scoutRoot);
  const mcpServers = readJsonFile<McpServersFile>(join(assetsRoot, CodexAssetLayout.mcpServers));
  const shellTools = readJsonFile<ShellToolsFile>(join(assetsRoot, CodexAssetLayout.shellTools));
  const agentRoles = options.agentRoles ?? Object.values(ScoutAgentRoles);
  const mountRoots: string[] = [];
  const readableRoots: string[] = [];
  const writableRoots: string[] = [];
  const roleRoots: Array<{
    role: ScoutAgentRole;
    mountRoot: string;
    artifactRoot: string;
    readableRoots: string[];
    writableRoots: string[];
  }> = [];

  for (const role of agentRoles) {
    const profile = resolveAgentProfile(profiles, role);
    const agentRoot = join(runRoot, "agents", role);
    const mountRoot = join(agentRoot, "mount");
    const artifactRoot = join(agentRoot, "artifacts");
    mountRoots.push(mountRoot);
    const profileReadableRoots = resolveProfileRoots({
      roots: profile.readableRoots,
      scoutRoot,
      runRoot,
      mountRoot,
      artifactRoot,
    });
    const profileWritableRoots = resolveProfileRoots({
      roots: profile.writableRoots,
      scoutRoot,
      runRoot,
      mountRoot,
      artifactRoot,
    });
    const runtimeReadableRoots = resolveRoleRuntimeReadableRoots({
      assetsRoot,
      role,
      profile,
      shellTools: shellTools.tools,
    });
    readableRoots.push(mountRoot, ...profileReadableRoots, ...runtimeReadableRoots);
    writableRoots.push(artifactRoot, ...profileWritableRoots);
    roleRoots.push({
      role,
      mountRoot,
      artifactRoot,
      readableRoots: [...profileReadableRoots, ...runtimeReadableRoots],
      writableRoots: profileWritableRoots,
    });
    const dynamicValues = buildMountMacroValues({
      scoutRoot,
      runRoot,
      mountRoot,
      artifactRoot,
      assetCommitId: "",
      runId: basename(runRoot),
    });
    for (const serverName of profile.mcpServers) {
      const server = mcpServers.servers[serverName];
      if (!server) throw new Error(`Agent profile references unknown MCP server: ${serverName}`);
      writableRoots.push(...resolveDynamicRoots(server.writableRoots, dynamicValues));
    }
  }

  const uniqueMountRoots = uniqueResolved(mountRoots);
  const uniqueReadableRoots = uniqueResolved(readableRoots);
  const uniqueWritableRoots = uniqueResolved(writableRoots);
  return {
    mountRoots: uniqueMountRoots,
    readableRoots: uniqueReadableRoots,
    writableRoots: uniqueWritableRoots,
    permissionProfiles: buildPermissionProfiles({ scoutRoot, roleRoots }),
  };
}

function buildPreparedClientRootPlan(
  environment: RunEnvironment,
  currentScoutRoot: string,
): RunAppServerRootPlan {
  const agents = Object.values(environment.agents);
  const mountRoots = uniqueResolved(environment.rootAccess.mountRoots);
  const scoutRoot = resolve(currentScoutRoot);
  const assetsRoot = join(scoutRoot, "assets", "codex");
  const shellTools = readJsonFile<ShellToolsFile>(join(assetsRoot, CodexAssetLayout.shellTools));
  const roleRoots = agents.map((agent) => ({
    role: agent.role,
    mountRoot: agent.mount.mountRoot,
    artifactRoot: agent.mount.artifactRoot,
    readableRoots: [
      ...agent.mount.readableRoots,
      ...resolveRoleRuntimeReadableRoots({
        assetsRoot,
        role: agent.role,
        profile: agent.mount.agentProfile,
        shellTools: shellTools.tools,
      }),
    ],
    writableRoots: agent.mount.writableRoots,
  }));
  return {
    mountRoots,
    readableRoots: uniqueResolved([
      ...environment.rootAccess.readableRoots,
      ...roleRoots.flatMap((role) => role.readableRoots),
    ]),
    writableRoots: uniqueResolved(environment.rootAccess.writableRoots),
    permissionProfiles: buildPermissionProfiles({
      scoutRoot,
      roleRoots,
    }),
  };
}

function buildClientConfig(input: {
  mountRoots: string[];
  permissionProfiles: RunAppServerRootPlan["permissionProfiles"];
  model: CodexModelConfig;
  providerConfig: ReturnType<typeof readHomeProviderConfig>;
}): string {
  const homeConfig = input.providerConfig;
  const mountRoots = uniqueResolved(input.mountRoots);
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
    'default_permissions = ":read-only"',
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
  for (const role of Object.values(ScoutAgentRoles)) {
    const profile = input.permissionProfiles[role];
    if (!profile) continue;
    lines.push(
      `[permissions.${profile.id}.filesystem]`,
      '":minimal" = "read"',
    );
    const rules = new Map<string, "read" | "write" | "deny">();
    for (const root of profile.readableRoots) rules.set(root, "read");
    for (const root of profile.writableRoots) rules.set(root, "write");
    for (const root of profile.deniedRoots) rules.set(root, "deny");
    for (const [root, access] of [...rules].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`"${escapeToml(root)}" = "${access}"`);
    }
    lines.push(
      "",
      `[permissions.${profile.id}.network]`,
      "enabled = false",
      "",
    );
  }
  for (const mountRoot of mountRoots) {
    lines.push(
      `[projects."${escapeToml(mountRoot)}"]`,
      'trust_level = "trusted"',
      "",
    );
  }
  return lines.join("\n");
}

function buildPermissionProfiles(input: {
  scoutRoot: string;
  roleRoots: Array<{
    role: ScoutAgentRole;
    mountRoot: string;
    artifactRoot: string;
    readableRoots: string[];
    writableRoots: string[];
  }>;
}): RunAppServerRootPlan["permissionProfiles"] {
  const scoutRoot = resolve(input.scoutRoot);
  const runsRoot = join(scoutRoot, "run");
  const logicalSkillRoot = join(scoutRoot, "assets", "codex", "skills");
  const canonicalSkillRoot = realpathSync(logicalSkillRoot);
  const artifactRoots = input.roleRoots.map((role) => role.artifactRoot);
  return Object.fromEntries(input.roleRoots.map((role) => [
    role.role,
    {
      id: permissionProfileId(role.role),
      mountRoot: resolve(role.mountRoot),
      readableRoots: uniqueResolved([
        role.mountRoot,
        ...artifactRoots,
        ...role.readableRoots,
      ]),
      writableRoots: uniqueResolved([
        role.artifactRoot,
        ...role.writableRoots,
      ]),
      deniedRoots: uniqueResolved([
        runsRoot,
        join(role.mountRoot, ".scout", "skills"),
        logicalSkillRoot,
        canonicalSkillRoot,
      ]),
    } satisfies RunAgentPermissionPlan,
  ]));
}

function resolveRoleRuntimeReadableRoots(input: {
  assetsRoot: string;
  role: ScoutAgentRole;
  profile: AgentProfile;
  shellTools: ShellToolContract[];
}): string[] {
  const roots = [
    ...readablePathVariants(join(input.assetsRoot, CodexAssetLayout.agentsMd)),
    ...readablePathVariants(join(input.assetsRoot, roleAgentPath(input.role))),
  ];
  if (input.role !== ScoutAgentRoles.Coordinator) {
    roots.push(...readablePathVariants(join(input.assetsRoot, CodexAssetLayout.workerAgent)));
  }
  for (const name of input.profile.customAgents) {
    roots.push(...readablePathVariants(
      join(input.assetsRoot, CodexAssetLayout.customAgentsRoot, `${name}.toml`),
    ));
  }
  const pluginPaths = listPluginSourcePaths(join(input.assetsRoot, CodexAssetLayout.pluginsRoot));
  const pluginsByName = new Map(pluginPaths.map((path) => [basename(path), path] as const));
  for (const name of input.profile.plugins) {
    const path = pluginsByName.get(name);
    if (!path) throw new Error(`Agent profile references unknown plugin: ${name}`);
    roots.push(...readablePathVariants(path));
  }
  const toolsById = new Map(input.shellTools.map((tool) => [tool.id, tool] as const));
  for (const id of input.profile.shellTools ?? []) {
    const tool = toolsById.get(id);
    if (!tool) throw new Error(`Agent profile references unknown shell tool: ${id}`);
    const command = resolveShellToolCommand(tool, input.assetsRoot);
    if (command) roots.push(...readableExecutableRoots(command));
    for (const argument of tool.args ?? []) {
      if (!argument.startsWith("assets/")) continue;
      roots.push(...readablePathVariants(resolveAssetArg(argument, input.assetsRoot), true));
    }
  }
  return uniqueResolved(roots);
}

function readableExecutableRoots(path: string): string[] {
  const logicalPath = resolve(path);
  const canonicalPath = realpathSync(logicalPath);
  const roots = readablePathVariants(logicalPath, true);
  for (const executablePath of [logicalPath, canonicalPath]) {
    if (isMinimalSystemExecutable(executablePath)) continue;
    roots.push(dirname(dirname(executablePath)));
    const cellarSegment = `${sep}Cellar${sep}`;
    const cellarIndex = executablePath.indexOf(cellarSegment);
    if (cellarIndex >= 0) {
      const homebrewPrefix = executablePath.slice(0, cellarIndex);
      roots.push(
        join(homebrewPrefix, "Cellar"),
        join(homebrewPrefix, "opt"),
        join(homebrewPrefix, "etc"),
      );
    }
  }
  return uniqueResolved(roots);
}

function isMinimalSystemExecutable(path: string): boolean {
  return ["/bin", "/sbin", "/usr/bin", "/usr/sbin"].some((root) =>
    path === root || path.startsWith(`${root}/`)
  );
}

function readablePathVariants(path: string, includeRuntimeDirectory = false): string[] {
  const logicalPath = resolve(path);
  const canonicalPath = realpathSync(logicalPath);
  return includeRuntimeDirectory
    ? uniqueResolved([dirname(logicalPath), dirname(canonicalPath)])
    : uniqueResolved([logicalPath, canonicalPath]);
}

function listPluginSourcePaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (existsSync(join(path, ".codex-plugin", "plugin.json"))) paths.push(path);
    else paths.push(...listPluginSourcePaths(path));
  }
  return paths;
}

function permissionProfileId(role: ScoutAgentRole): string {
  switch (role) {
    case ScoutAgentRoles.Coordinator:
      return ScoutAgentPermissionProfiles.Coordinator;
    case ScoutAgentRoles.Researcher:
      return ScoutAgentPermissionProfiles.Researcher;
    case ScoutAgentRoles.Verifier:
      return ScoutAgentPermissionProfiles.Verifier;
    case ScoutAgentRoles.Validator:
      return ScoutAgentPermissionProfiles.Validator;
  }
}

function resolveProfileRoots(input: {
  roots?: string[];
  scoutRoot: string;
  runRoot: string;
  mountRoot: string;
  artifactRoot: string;
}): string[] {
  const dynamicValues = buildMountMacroValues({
    scoutRoot: input.scoutRoot,
    runRoot: input.runRoot,
    mountRoot: input.mountRoot,
    artifactRoot: input.artifactRoot,
    assetCommitId: "",
  });
  return (input.roots ?? [])
    .map((root) => resolveMountMacros(root, dynamicValues))
    .filter((root) => root.length > 0)
    .map((root) => resolveProfileRoot(root, input.scoutRoot));
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

function resolveProfileRoot(root: string, scoutRoot: string): string {
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return resolve(homedir(), root.slice(2));
  if (isAbsolute(root)) return root;
  return resolve(scoutRoot, root);
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

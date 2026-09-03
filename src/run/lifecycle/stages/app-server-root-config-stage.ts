import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  buildScoutSkillCatalog,
  listScoutSkillPaths,
  resolveScoutSkillsForPhases,
} from "../../../asset-store/assets/skill-catalog.js";
import { readWorkflowProfile } from "../../../asset-store/assets/workflow-profiles.js";
import { WorkflowBuilder } from "../../../asset-store/builders/workflow-builder.js";
import { CodexAssetLayout } from "../../../asset-store/assets/asset-layout.js";
import { resolveAssetArg } from "../../../asset-store/files/asset-paths.js";
import { resolveShellToolCommand } from "../../../asset-store/files/command-resolution.js";
import {
  createMountMacroValues,
  resolveMountMacros,
} from "../../../asset-store/mount/macros.js";
import type { AgentProfile } from "../../../asset-store/contracts/profile.js";
import type {
  McpServersFile,
  ShellToolContract,
  ShellToolsFile,
} from "../../../asset-store/contracts/resources.js";
import {
  scoutAgentPermissionProfile,
  type ScoutAgentRole,
} from "../../../agent/thread/types.js";
import { readJsonFile } from "../../../core/fs.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunEnvironment } from "../../types.js";
import { SynthesisPhase } from "../../../core/workflow/index.js";
import type { RunStage } from "../run-stage.js";

/** Per-role local-command filesystem permissions rendered into Codex config. */
export interface RunAgentFilesystemPermissionProfile {
  id: string;
  mountRoot: string;
  readableRoots: string[];
  writableRoots: string[];
  deniedRoots: string[];
}

/** Run-wide roots plus the role-owned filesystem permission profiles. */
export interface RunAppServerRootConfig {
  mountRoots: string[];
  readableRoots: string[];
  writableRoots: string[];
  permissionProfiles: Partial<Record<ScoutAgentRole, RunAgentFilesystemPermissionProfile>>;
}

/**
 * Computes the filesystem projection required by the Codex app-server.
 * This is a lifecycle concern because its inputs come from the active
 * RunScope; it does not materialize mounts or start the app-server.
 */
export class AppServerRootConfigStage implements RunStage {
  readonly id = "app_server_root_config";
  private config?: RunAppServerRootConfig;
  private stopped = false;

  constructor(private readonly options: {
    agentRoles?: readonly ScoutAgentRole[];
  } = {}) {}

  get rootConfig(): RunAppServerRootConfig {
    if (!this.config) throw new Error("App-server root config stage has not completed.");
    return this.config;
  }

  get prepared(): boolean {
    return this.config !== undefined;
  }

  async start(): Promise<void> {
    const scope = currentRunScope();
    this.config = scope.hasEnvironment
      ? createPreparedClientRootConfig(scope.environment, scope.scoutRoot)
      : createClientRootConfig({
        scoutRoot: scope.scoutRoot,
        runRoot: scope.runRoot,
        workflowProfileName: scope.scoutConfig.workflow.profile,
        agentRoles: this.options.agentRoles
          ?? scope.scheduler.snapshot().roles.map((role) => role.name),
      });
    this.stopped = false;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.config = undefined;
  }
}

/** Creates the root configuration before mounts exist, using the selected Workflow Profile. */
export function createClientRootConfig(options: {
  scoutRoot: string;
  runRoot: string;
  workflowProfileName: string;
  agentRoles?: readonly ScoutAgentRole[];
}): RunAppServerRootConfig {
  const scoutRoot = resolve(options.scoutRoot);
  const runRoot = resolve(options.runRoot);
  const assetsRoot = join(scoutRoot, "assets", "codex");
  const workflow = readWorkflowProfile(scoutRoot, options.workflowProfileName);
  const workflowBuilder = new WorkflowBuilder(workflow);
  const graphState = workflowBuilder.build();
  const workflowDomain = graphState.domain;
  const mcpServers = readJsonFile<McpServersFile>(join(assetsRoot, CodexAssetLayout.mcpServers));
  const shellTools = readJsonFile<ShellToolsFile>(join(assetsRoot, CodexAssetLayout.shellTools));
  const agentRoles = options.agentRoles ?? graphState.roles.map((role) => role.name);
  const mountRoots: string[] = [];
  const readableRoots: string[] = [];
  const writableRoots: string[] = [];
  const roleRoots: AppServerRoleRoots[] = [];

  for (const role of agentRoles) {
    const profile = workflowBuilder.buildAgentProfile(role);
    const agentRoot = join(runRoot, "agents", role);
    const mountRoot = join(agentRoot, "mount");
    const artifactRoot = join(agentRoot, "artifacts");
    const tempRoot = join(agentRoot, "tmp");
    // The app-server starts before environment materialization and needs this
    // runtime root to exist for its permission profile.
    mkdirSync(tempRoot, { recursive: true });
    mountRoots.push(mountRoot);
    const profileReadableRoots = resolveProfileRoots({
      roots: profile.readableRoots,
      scoutRoot,
      runRoot,
      mountRoot,
      artifactRoot,
      tempRoot,
    });
    const profileWritableRoots = resolveProfileRoots({
      roots: profile.writableRoots,
      scoutRoot,
      runRoot,
      mountRoot,
      artifactRoot,
      tempRoot,
    });
    const runtimeReadableRoots = resolveRoleRuntimeReadableRoots({
      assetsRoot,
      profile,
      workflowDomain,
      shellTools: shellTools.tools,
    });
    readableRoots.push(mountRoot, ...profileReadableRoots, ...runtimeReadableRoots);
    writableRoots.push(tempRoot, artifactRoot, ...profileWritableRoots);
    roleRoots.push({
      role,
      mountRoot,
      artifactRoot,
      tempRoot,
      readableRoots: [...profileReadableRoots, ...runtimeReadableRoots],
      writableRoots: profileWritableRoots,
    });
    const dynamicValues = createMountMacroValues({
      scoutRoot,
      runRoot,
      mountRoot,
      artifactRoot,
      tempRoot,
      assetCommitId: "",
      runId: basename(runRoot),
    });
    for (const serverName of profile.mcpServers) {
      const server = mcpServers.servers[serverName];
      if (!server) throw new Error(`Agent profile references unknown MCP server: ${serverName}`);
      writableRoots.push(...resolveDynamicRoots(server.writableRoots, dynamicValues));
    }
  }

  return {
    mountRoots: uniqueResolved(mountRoots),
    readableRoots: uniqueResolved(readableRoots),
    writableRoots: uniqueResolved(writableRoots),
    permissionProfiles: createPermissionProfiles({ scoutRoot, roleRoots }),
  };
}

/** Creates the root configuration after mounts have been prepared, using the Scheduler domain fact. */
export function createPreparedClientRootConfig(
  environment: RunEnvironment,
  currentScoutRoot: string,
): RunAppServerRootConfig {
  const agents = Object.values(environment.agents);
  const mountRoots = uniqueResolved(environment.rootAccess.mountRoots);
  const scoutRoot = resolve(currentScoutRoot);
  const assetsRoot = join(scoutRoot, "assets", "codex");
  const workflowDomain = currentRunScope().scheduler.snapshot().domain;
  const shellTools = readJsonFile<ShellToolsFile>(join(assetsRoot, CodexAssetLayout.shellTools));
  const roleRoots = agents.map((agent) => ({
    role: agent.role,
    mountRoot: agent.mount.mountRoot,
    artifactRoot: agent.mount.artifactRoot,
    tempRoot: agent.mount.tempRoot,
    readableRoots: [
      ...agent.mount.readableRoots,
      ...resolveRoleRuntimeReadableRoots({
        assetsRoot,
        profile: agent.mount.agentProfile,
        workflowDomain,
        shellTools: shellTools.tools,
      }),
    ],
    writableRoots: [agent.mount.tempRoot, ...agent.mount.writableRoots],
  }));
  return {
    mountRoots,
    readableRoots: uniqueResolved([
      ...environment.rootAccess.readableRoots,
      ...roleRoots.flatMap((role) => role.readableRoots),
    ]),
    writableRoots: uniqueResolved([
      ...environment.rootAccess.writableRoots,
      ...roleRoots.map((role) => role.tempRoot),
    ]),
    permissionProfiles: createPermissionProfiles({ scoutRoot, roleRoots }),
  };
}

interface AppServerRoleRoots {
  role: ScoutAgentRole;
  mountRoot: string;
  artifactRoot: string;
  tempRoot: string;
  readableRoots: string[];
  writableRoots: string[];
}

function createPermissionProfiles(input: {
  scoutRoot: string;
  roleRoots: AppServerRoleRoots[];
}): RunAppServerRootConfig["permissionProfiles"] {
  const scoutRoot = resolve(input.scoutRoot);
  const runsRoot = join(scoutRoot, "run");
  const logicalSkillRoot = join(scoutRoot, "assets", "codex", "skills");
  const canonicalSkillRoot = realpathSync(logicalSkillRoot);
  const artifactRoots = input.roleRoots.map((role) => role.artifactRoot);
  const macosRuntimeReadableRoots = process.platform === "darwin"
    ? ["/System/Library/OpenSSL"]
    : [];
  const macosRuntimeWritableRoots = process.platform === "darwin"
    ? uniqueResolved([tmpdir(), realpathSync(tmpdir())])
    : [];
  return Object.fromEntries(input.roleRoots.map((role) => [
    role.role,
    {
      id: permissionProfileId(role.role),
      mountRoot: resolve(role.mountRoot),
      readableRoots: uniqueResolved([
        role.mountRoot,
        ...artifactRoots,
        ...role.readableRoots,
        ...macosRuntimeReadableRoots,
      ]),
      writableRoots: uniqueResolved([
        role.artifactRoot,
        role.tempRoot,
        ...role.writableRoots,
        ...macosRuntimeWritableRoots,
      ]),
      deniedRoots: uniqueResolved([
        runsRoot,
        logicalSkillRoot,
        canonicalSkillRoot,
      ]),
    } satisfies RunAgentFilesystemPermissionProfile,
  ]));
}

function resolveRoleRuntimeReadableRoots(input: {
  assetsRoot: string;
  profile: AgentProfile;
  workflowDomain: string;
  shellTools: ShellToolContract[];
}): string[] {
  const roots = [
    ...readablePathVariants(join(input.assetsRoot, CodexAssetLayout.agentsMd)),
  ];
  if (!input.profile.phases.includes(SynthesisPhase)) {
    roots.push(...readablePathVariants(join(input.assetsRoot, CodexAssetLayout.workerAgentsMd)));
  }
  const skillCatalog = buildScoutSkillCatalog({
    assetsRoot: input.assetsRoot,
    skillPaths: listScoutSkillPaths(input.assetsRoot),
  });
  for (const skill of resolveScoutSkillsForPhases(skillCatalog, {
    domain: input.workflowDomain,
    phases: input.profile.phases,
  })) {
    roots.push(...readablePathVariants(
      join(input.assetsRoot, CodexAssetLayout.skillsRoot, skill.name),
    ));
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
  return scoutAgentPermissionProfile(role);
}

function resolveProfileRoots(input: {
  roots?: string[];
  scoutRoot: string;
  runRoot: string;
  mountRoot: string;
  artifactRoot: string;
  tempRoot: string;
}): string[] {
  const dynamicValues = createMountMacroValues({
    scoutRoot: input.scoutRoot,
    runRoot: input.runRoot,
    mountRoot: input.mountRoot,
    artifactRoot: input.artifactRoot,
    tempRoot: input.tempRoot,
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

function uniqueResolved(roots: string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].sort();
}

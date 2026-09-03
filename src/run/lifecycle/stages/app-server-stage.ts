import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createCodexAppServerClient,
  type CodexAppServerClientBundle,
} from "../../../agent-server/codex/app-server-factory.js";
import {
  buildClientConfig,
  readHomeProviderConfig,
  rebindTargetCodexAuth,
} from "../../../agent-server/codex/app-server-config.js";
import {
  AppServerRootConfigStage,
  type RunAppServerRootConfig,
} from "./app-server-root-config-stage.js";
import { readWorkflowProfile } from "../../../asset-store/assets/workflow-profiles.js";
import { resolveSynthesisRole } from "../../../core/workflow/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";
import type { ScoutAgentRole } from "../../../agent/thread/types.js";

export type {
  RunAgentFilesystemPermissionProfile,
  RunAppServerRootConfig,
} from "./app-server-root-config-stage.js";

/** Optional role selection used when an environment is not yet prepared. */
export interface RunAppServerStageOptions {
  agentRoles?: readonly ScoutAgentRole[];
  rootConfigStage?: AppServerRootConfigStage;
}

/**
 * Creates the per-run Codex app-server client and binds it to RunScope.
 * Root permissions and Codex configuration are produced by their respective
 * adapters; this stage owns only lifecycle ordering and cleanup.
 */
export class RunAppServerStage implements RunStage {
  readonly id = "app_server";
  private readonly options: RunAppServerStageOptions;
  private clientBundle?: CodexAppServerClientBundle;
  private clientRootConfig?: RunAppServerRootConfig;
  private stopped = false;
  private readonly rootConfigStage: AppServerRootConfigStage;
  private readonly ownsRootConfigStage: boolean;

  constructor(options: RunAppServerStageOptions = {}) {
    this.options = options;
    this.rootConfigStage = options.rootConfigStage
      ?? new AppServerRootConfigStage({ agentRoles: options.agentRoles });
    this.ownsRootConfigStage = options.rootConfigStage === undefined;
  }

  get appServerClient(): CodexAppServerClientBundle {
    if (!this.clientBundle) throw new Error("Run app-server stage has not completed.");
    return this.clientBundle;
  }

  get rootConfig(): RunAppServerRootConfig {
    if (!this.clientRootConfig) throw new Error("Run app-server stage has not completed.");
    return this.clientRootConfig;
  }

  async start(): Promise<void> {
    const scope = currentRunScope();
    const synthesisRole = resolveSynthesisRole(scope.scheduler.snapshot()).name;
    if (!this.rootConfigStage.prepared) await this.rootConfigStage.start();
    const rootConfig = this.rootConfigStage.rootConfig;
    const defaultModel = scope.hasEnvironment
      ? scope.environment.agents[synthesisRole].mount.agentProfile.model
      : readWorkflowProfile(scope.scoutRoot, scope.scoutConfig.workflow.profile)
          .profile.defaults.model;
    const runRoot = resolve(scope.runRoot);
    const logsRoot = join(runRoot, "logs");
    const isolatedHome = join(runRoot, "codex-home");
    const isolatedCodexHome = join(isolatedHome, ".codex");
    mkdirSync(isolatedCodexHome, { recursive: true });
    const providerConfig = readHomeProviderConfig(defaultModel.provider);
    rebindTargetCodexAuth(isolatedCodexHome, providerConfig.authPath);
    const configToml = buildClientConfig({
      mountRoots: rootConfig.mountRoots,
      permissionProfiles: rootConfig.permissionProfiles,
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
      mountRoots: rootConfig.mountRoots,
      rootConfig,
    };
    const clientBundle = createCodexAppServerClient(clientOptions);
    try {
      await clientBundle.client.startSession();
      scope.setAppServer(clientBundle.client);
      scope.logger.info({
        module: "run.lifecycle",
        event: "codex_app_server_started",
        message: `Started Scout-owned Codex app-server ${clientBundle.codexVersion}.`,
        data: {
          codexPath: clientBundle.codexPath,
          expectedVersion: clientBundle.codexVersion,
          actualVersion: clientBundle.client.codexVersion,
        },
      });
    } catch (error) {
      clientBundle.client.close();
      throw error;
    }
    this.clientRootConfig = rootConfig;
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
      if (this.ownsRootConfigStage) await this.rootConfigStage.stop();
    }
  }
}

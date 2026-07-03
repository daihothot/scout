import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAgents } from "../../src/run/index.js";
import { buildRunContextBundle } from "../../src/run/types.js";
import { ScoutAgentRoles } from "../../src/agent/thread/types.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import type { ScoutDomain } from "../../src/domain/index.js";
import type { PreparedRun } from "../../src/run/run-env-preparation.js";
import type { CodexMount, AssetCommit } from "../../src/asset-store/index.js";
import type {
  CodexAppServerClientBundle,
} from "../../src/agent-server/codex/app-server-factory.js";
import type { PreparedRunClients } from "../../src/run/run-client-preparation.js";

test("prepareAgents starts all prepared agent threads with prepared clients", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-run-agent-preparation-"));
  const runId = "run-agent-prep-test";
  const startedThreads: string[] = [];
  const preparedRun = createPreparedRun({
    root,
    runId,
  });
  const preparedClients = createPreparedClients({
    root,
    preparedRun,
    onStartThread: (threadOptions) => {
      const role = Object.values(ScoutAgentRoles).find((candidate) =>
        threadOptions.cwd?.includes(`${candidate}/mount`)
      ) ?? "unknown";
      const threadId = `thread-${role}`;
      startedThreads.push(threadId);
      return threadId;
    },
  });
  const logger = createNoopLogger();
  const domain = createStaticDomain();

  const prepared = await prepareAgents({
    preparedRun,
    preparedClients,
    repoRoot: root,
    logger,
    eventBus: new InMemoryEventBus(),
    domain,
  });

  assert.equal(prepared.appServerClient, preparedClients.appServerClient);
  assert.deepEqual(startedThreads.sort(), [
    "thread-coordinator",
    "thread-researcher",
    "thread-validator",
    "thread-verifier",
  ]);
  assert.deepEqual(Object.keys(prepared.agents).sort(), Object.values(ScoutAgentRoles).sort());
  assert.equal(prepared.registry.resolveAgentByThreadId("thread-verifier"), prepared.agents.verifier);
  assert.equal(prepared.agents.coordinator.threadSnapshot?.threadPreflight?.result.status, "passed");
  assert.equal(prepared.agents.verifier.threadSnapshot?.threadPreflight?.threadId, "thread-verifier");
  assert.deepEqual(prepared.taskStore.listTasks(), []);
  assert.deepEqual(prepared.contextBundle, buildRunContextBundle({
    runId,
    assetCommit: preparedRun.agents.coordinator.assetCommit,
  }));
});

function createPreparedRun(input: {
  root: string;
  runId: string;
}): PreparedRun {
  const agents = Object.fromEntries(Object.values(ScoutAgentRoles).map((role) => {
    const mount = createMount(input.root, input.runId, role);
    return [role, {
      role,
      mount,
      preflight: {
        status: "passed",
      },
      preflightPath: join(mount.artifactRoot, "app-server-preflight.json"),
      assetCommit: createAssetCommit(mount),
      assetCommitPath: join(mount.artifactRoot, "asset-commit.json"),
    }];
  })) as PreparedRun["agents"];
  return {
    runId: input.runId,
    repoRoot: input.root,
    agents,
    rootAccess: {
      mountRoots: Object.values(agents).map((agent) => agent.mount.mountRoot),
      trustedRoots: [input.root],
      writableRoots: Object.values(agents).map((agent) => agent.mount.artifactRoot),
    },
  };
}

function createPreparedClients(input: {
  root: string;
  preparedRun: PreparedRun;
  onStartThread(options: { cwd?: string }): string;
}): PreparedRunClients {
  const client = {
    startThread: async (options: { cwd?: string }) => {
      const threadId = input.onStartThread(options);
      return {
        threadId,
        response: {
          thread: { id: threadId },
        },
      };
    },
    request: async (_method: string, params: { threadId?: string }) => ({
      threadId: params.threadId,
      servers: [],
    }),
    close: () => undefined,
  };
  const appServerClient: CodexAppServerClientBundle = {
    client: client as CodexAppServerClientBundle["client"],
    isolatedHome: join(input.root, ".codex-home"),
    isolatedCodexHome: join(input.root, ".codex-home", ".codex"),
    defaultWritableRoots: input.preparedRun.rootAccess.writableRoots,
    mountRoots: input.preparedRun.rootAccess.mountRoots,
    trustedRoots: input.preparedRun.rootAccess.trustedRoots,
  };
  return {
    rootPlan: {
      mountRoots: input.preparedRun.rootAccess.mountRoots,
      trustedRoots: input.preparedRun.rootAccess.trustedRoots,
      writableRoots: input.preparedRun.rootAccess.writableRoots,
      defaultWritableRoots: input.preparedRun.rootAccess.writableRoots,
    },
    appServerClient,
  };
}

function createMount(root: string, runId: string, role: string): CodexMount {
  const mountRoot = join(root, "run", runId, "agents", role, "mount");
  const artifactRoot = join(root, "run", runId, "agents", role, "artifacts");
  const logsRoot = join(root, "run", runId, "agents", role, "logs");
  mkdirSync(join(mountRoot, "agents"), { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(logsRoot, { recursive: true });
  for (const agentRole of Object.values(ScoutAgentRoles)) {
    writeFileSync(join(mountRoot, "agents", `${agentRole}.AGENTS.md`), `${agentRole} instructions`, "utf8");
  }
  writeFileSync(join(mountRoot, "agents", "worker.AGENTS.md"), "worker instructions", "utf8");
  return {
    agentId: role,
    agentProfile: {
      config: "config/config.toml",
      skills: [],
      mcpServers: [],
      plugins: [],
    },
    assetCommitId: `ac_${role}`,
    mountId: `mount-${role}`,
    mountRoot,
    runRoot: root,
    artifactRoot,
    logsRoot,
    issues: [],
    trustedRoots: [root],
    writableRoots: [artifactRoot],
    shellTools: [],
    mcpServers: [],
    skills: [],
    plugins: [],
    manifestPath: join(mountRoot, "mount-manifest.json"),
    resourceHash: "hash-test",
  };
}

function createAssetCommit(mount: CodexMount): AssetCommit {
  return {
    ...mount,
    createdAt: "2026-07-03T00:00:00.000Z",
    status: "preflight_passed",
  };
}

function createStaticDomain(): ScoutDomain {
  return {
    domainId: "test",
    name: "test",
    dynamicToolsForRole: () => [],
  };
}

function createNoopLogger(): Logger {
  return {
    registerAgentLogRoot: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

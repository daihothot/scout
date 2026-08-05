import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import {
  preflightCodexAppServerMount,
  summarizeAgentServerPreflight,
} from "../../src/agent-server/codex/app-server-preflight.js";
import type { CodexMount } from "../../src/asset-store/types.js";

test("mount preflight reports missing profile roots instead of deferring to a turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-root-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  const missingTrustedRoot = join(root, "missing-knowledge");
  const missingWritableRoot = join(root, "missing-codebase");
  mkdirSync(mountRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      trustedRoots: [mountRoot, missingTrustedRoot],
      writableRoots: [artifactRoot, missingWritableRoot],
    }),
    appServer: testAppServer(),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.rootAccess?.status, "failed");
  assert.deepEqual(
    report.rootAccess?.roots.filter((entry) => entry.status === "failed")
      .map((entry) => [entry.path, entry.access]),
    [
      [missingTrustedRoot, "trusted"],
      [missingWritableRoot, "writable"],
    ],
  );
});

test("mount preflight accepts readable trusted roots and writable roots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-root-preflight-passed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  mkdirSync(mountRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      trustedRoots: [mountRoot],
      writableRoots: [artifactRoot],
    }),
    appServer: testAppServer(),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.rootAccess?.status, "passed");
});

test("mount preflight redacts credentials from persisted config layers", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-config-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  mkdirSync(mountRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  const appServer = {
    request: async (method: string) => method === "config/read"
      ? {
          layers: [{
            config: {
              model_providers: {
                GuruOpenAI: {
                  base_url: "https://example.invalid/v1",
                  env_key: "GURU_API_KEY",
                  experimental_bearer_token: "source-device-token",
                  nested: [{ api_key: "nested-api-key", name: "preserved" }],
                },
              },
            },
          }],
        }
      : {},
  } as unknown as CodexAppServerClient;

  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      trustedRoots: [mountRoot],
      writableRoots: [artifactRoot],
    }),
    appServer,
  });

  assert.equal(report.status, "passed");
  assert.deepEqual(report.configLayers, [{
    config: {
      model_providers: {
        GuruOpenAI: {
          base_url: "https://example.invalid/v1",
          env_key: "GURU_API_KEY",
          experimental_bearer_token: "[redacted]",
          nested: [{ api_key: "[redacted]", name: "preserved" }],
        },
      },
    },
  }]);
});

test("preflight persistence keeps catalog state without device-local payloads", () => {
  const root = "/private/tmp/source-scout/run/run-portable";
  const mount = testMount({
    root,
    mountRoot: `${root}/agents/coordinator/mount`,
    artifactRoot: `${root}/agents/coordinator/artifacts`,
    trustedRoots: [],
    writableRoots: [],
  });
  const report = {
    status: "passed" as const,
    rootAccess: {
      status: "passed" as const,
      roots: [{
        path: `${root}/agents/coordinator/mount`,
        access: "writable" as const,
        status: "passed" as const,
      }, {
        path: "/Users/source/.guru/knowledge",
        access: "trusted" as const,
        status: "failed" as const,
        error: "missing source root\nfull stack",
      }],
    },
    configLayers: [{
      name: {
        type: "project",
        dotCodexFolder: `${root}/agents/coordinator/mount/.codex`,
      },
      version: "sha256:config",
      config: {
        model_providers: { GuruOpenAI: { api_key: "secret" } },
      },
    }],
    skillsList: {
      data: [{
        cwd: `${root}/agents/coordinator/mount`,
        skills: [{
          name: "openai-docs",
          description: "large body",
          path: `${root}/codex-home/skills/openai-docs/SKILL.md`,
          scope: "system",
          enabled: true,
        }],
        errors: [],
      }],
    },
    pluginList: {
      marketplaces: [{
        name: "openai-curated",
        path: `${root}/codex-home/.tmp/plugins/marketplace.json`,
        plugins: [{
          id: "linear@openai-curated",
          name: "linear",
          description: "large body",
          installed: false,
          enabled: false,
          interface: { longDescription: "large body" },
          source: { path: `${root}/plugins/linear` },
        }],
      }],
      marketplaceLoadErrors: [],
    },
    hooksList: {
      data: [{ cwd: `${root}/agents/coordinator/mount`, hooks: [], warnings: [], errors: [] }],
    },
  };

  const summary = summarizeAgentServerPreflight(report, mount);
  const serialized = JSON.stringify(summary);
  assert.ok(serialized.length < JSON.stringify(report).length);
  assert.equal(serialized.includes("large body"), false);
  assert.equal(serialized.includes("/Users/source"), false);
  assert.deepEqual(summary.pluginList, {
    marketplaces: [{
      name: "openai-curated",
      pluginCount: 1,
      plugins: [{
        id: "linear@openai-curated",
        name: "linear",
        installed: false,
        enabled: false,
      }],
    }],
    marketplaceCount: 1,
    pluginCount: 1,
    installedCount: 0,
    enabledCount: 0,
    marketplaceLoadErrors: [],
  });
  assert.equal(summary.rootAccess?.roots[0]?.path, "${SCOUT_MOUNT_ROOT}");
  assert.equal(summary.rootAccess?.roots[1]?.path, "knowledge");
});

function testMount(input: {
  root: string;
  mountRoot: string;
  artifactRoot: string;
  trustedRoots: string[];
  writableRoots: string[];
}): CodexMount {
  return {
    agentId: "coordinator",
    agentProfile: {
      config: "config/base.config.toml",
      multiAgent: false,
      maxThreads: 1,
      maxDepth: 1,
      customAgents: [],
      model: {
        id: "gpt-5.5",
        provider: "GuruOpenAI",
        reasoningEffort: "high",
        reasoningSummary: "concise",
      },
      skills: [],
      shellTools: [],
      mcpServers: [],
      plugins: [],
      trustedRoots: input.trustedRoots,
      writableRoots: input.writableRoots,
    },
    assetCommitId: "ac_preflight",
    mountId: "m_preflight",
    mountRoot: input.mountRoot,
    runRoot: input.root,
    artifactRoot: input.artifactRoot,
    logsRoot: join(input.root, "logs"),
    issues: [],
    trustedRoots: input.trustedRoots,
    writableRoots: input.writableRoots,
    shellTools: [],
    mcpServers: [],
    customAgents: [],
    skills: [],
    skillCatalog: [],
    plugins: [],
    manifestPath: join(input.mountRoot, "mount-manifest.json"),
    resourceHash: "resource-preflight",
  };
}

function testAppServer(): CodexAppServerClient {
  return {
    request: async () => ({}),
  } as unknown as CodexAppServerClient;
}

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import {
  createCodexAppServerMountPreflight,
  preflightCodexAppServerMount,
  summarizeAgentServerPreflight,
} from "../../src/agent-server/codex/app-server-preflight.js";
import type { CodexMount } from "../../src/asset-store/contracts/mount.js";
import type { ShellToolContract } from "../../src/asset-store/contracts/resources.js";

test("mount preflight reports missing profile roots instead of deferring to a turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-root-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  const missingReadableRoot = join(root, "missing-knowledge");
  const missingWritableRoot = join(root, "missing-codebase");
  mkdirSync(mountRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      readableRoots: [mountRoot, missingReadableRoot],
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
      [missingReadableRoot, "readable"],
      [missingWritableRoot, "writable"],
    ],
  );
});

test("mount preflight accepts readable and writable roots", async (t) => {
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
      readableRoots: [mountRoot],
      writableRoots: [artifactRoot],
    }),
    appServer: testAppServer(),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.rootAccess?.status, "passed");
});

test("mount preflight checks a binding-only shell wrapper without executing it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-shell-binding-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  const invokedPath = join(root, "invoked");
  const executable = join(mountRoot, "bin", "binding-tool");
  mkdirSync(join(mountRoot, "bin"), { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(executable, `#!/bin/sh\nprintf invoked > ${JSON.stringify(invokedPath)}\n`, "utf8");
  chmodSync(executable, 0o755);

  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      readableRoots: [mountRoot],
      writableRoots: [artifactRoot],
      shellTools: [testShellTool({ exposeAs: "binding-tool" })],
    }),
    appServer: testAppServer(),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.shellSmoke?.[0]?.status, "passed");
  assert.ok((report.shellSmoke?.[0]?.durationMs ?? -1) >= 0);
  assert.equal(existsSync(invokedPath), false);
});

test("mount preflight directly executes functional shell wrappers and checks markers", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-shell-functional-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  const executable = join(mountRoot, "bin", "functional-tool");
  mkdirSync(join(mountRoot, "bin"), { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(executable, "#!/bin/sh\nprintf 'FUNCTIONAL_OK %s' \"$1\"\n", "utf8");
  chmodSync(executable, 0o755);

  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      readableRoots: [mountRoot],
      writableRoots: [artifactRoot],
      shellTools: [testShellTool({
        exposeAs: "functional-tool",
        smoke: {
          scope: "mount",
          args: ["--smoke"],
          marker: "FUNCTIONAL_OK --smoke",
        },
      })],
    }),
    appServer: testAppServer(),
  });

  assert.equal(report.status, "passed");
  assert.deepEqual(report.shellSmoke?.map((item) => ({
    command: item.command,
    status: item.status,
    stdout: item.stdout,
  })), [{
    command: "functional-tool --smoke",
    status: "passed",
    stdout: "FUNCTIONAL_OK --smoke",
  }]);
  assert.ok((report.shellSmoke?.[0]?.durationMs ?? -1) >= 0);
});

test("mount preflight resolves a managed codebase before running CodeGraph status", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-codegraph-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  const codebaseRoot = join(root, "managed-codebase");
  mkdirSync(join(mountRoot, "bin"), { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(codebaseRoot, { recursive: true });
  writeFileSync(
    join(mountRoot, "bin", "jarvis"),
    `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(codebaseRoot)}\n`,
    "utf8",
  );
  chmodSync(join(mountRoot, "bin", "jarvis"), 0o755);
  writeFileSync(
    join(mountRoot, "bin", "codegraph"),
    "#!/bin/sh\nprintf 'CODEGRAPH_OK %s %s\\n' \"$1\" \"$2\"\n",
    "utf8",
  );
  chmodSync(join(mountRoot, "bin", "codegraph"), 0o755);

  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      readableRoots: [mountRoot, codebaseRoot],
      writableRoots: [artifactRoot, codebaseRoot],
      shellTools: [
        testShellTool({ exposeAs: "jarvis" }),
        testShellTool({
          exposeAs: "codegraph",
          smoke: {
            scope: "mount",
            args: ["status"],
            managedCodebase: "gurusdk-unity",
          },
        }),
      ],
    }),
    appServer: testAppServer(),
  });

  assert.equal(report.status, "passed");
  assert.deepEqual(report.shellSmoke?.filter((item) => item.command.startsWith("codegraph ")).map((item) => ({
    command: item.command,
    status: item.status,
    stdout: item.stdout,
  })), [{
    command: `codegraph status ${codebaseRoot}`,
    status: "passed",
    stdout: `CODEGRAPH_OK status ${codebaseRoot}`,
  }]);
});

test("mount preflight resolves a Node-based wrapper through the shared shell PATH", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-shell-node-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  const executable = join(mountRoot, "bin", "node-wrapper");
  mkdirSync(join(mountRoot, "bin"), { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(executable, "#!/usr/bin/env node\nprocess.stdout.write('NODE_OK ' + process.argv[2]);\n", "utf8");
  chmodSync(executable, 0o755);

  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      readableRoots: [mountRoot],
      writableRoots: [artifactRoot],
      shellTools: [testShellTool({
        exposeAs: "node-wrapper",
        smoke: {
          scope: "mount",
          args: ["--smoke"],
          marker: "NODE_OK --smoke",
        },
      })],
    }),
    appServer: testAppServer(),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.shellSmoke?.[0]?.stdout, "NODE_OK --smoke");
});

test("preflight batch shares run smokes and preserves mount smokes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-shell-scope-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invocationPath = join(root, "invocations");
  const mounts = ["first", "second", "broken"].map((name) => {
    const mountRoot = join(root, "agents", name, "mount");
    const artifactRoot = join(root, "agents", name, "artifacts");
    mkdirSync(join(mountRoot, "bin"), { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    for (const [tool, label, marker] of [
      ["run-tool", "run", "RUN_OK"],
      ["mount-tool", "mount", "MOUNT_OK"],
    ]) {
      const executable = join(mountRoot, "bin", tool);
      writeFileSync(executable, [
        "#!/bin/sh",
        `printf '${label}\\n' >> ${JSON.stringify(invocationPath)}`,
        `printf '${marker}\\n'`,
        "",
      ].join("\n"), "utf8");
      chmodSync(executable, name === "broken" && tool === "run-tool" ? 0o644 : 0o755);
    }
    return testMount({
      root,
      mountRoot,
      artifactRoot,
      readableRoots: [mountRoot],
      writableRoots: [artifactRoot],
      shellTools: [
        testShellTool({
          exposeAs: "run-tool",
          smoke: { scope: "run", args: ["--smoke"], marker: "RUN_OK" },
        }),
        testShellTool({
          exposeAs: "mount-tool",
          smoke: { scope: "mount", args: ["--smoke"], marker: "MOUNT_OK" },
        }),
      ],
    });
  });
  const preflight = createCodexAppServerMountPreflight(testAppServer(), 4);

  const reports = await Promise.all(mounts.map(preflight));

  assert.deepEqual(reports.map((report) => report.status), ["passed", "passed", "failed"]);
  assert.equal(
    reports[2]?.shellSmoke?.find((item) => item.command === "run-tool --smoke")?.status,
    "failed",
  );
  const invocations = readFileSync(invocationPath, "utf8").trim().split("\n").sort();
  assert.deepEqual(invocations, ["mount", "mount", "mount", "run"]);
});

test("preflight batch limits concurrent functional shell smokes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-shell-concurrency-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  const orderPath = join(root, "order");
  mkdirSync(join(mountRoot, "bin"), { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  const shellTools = Array.from({ length: 5 }, (_, index) => {
    const exposeAs = `bounded-${index}`;
    const executable = join(mountRoot, "bin", exposeAs);
    writeFileSync(executable, [
      "#!/bin/sh",
      `printf 'start-${index}\\n' >> ${JSON.stringify(orderPath)}`,
      "sleep 0.1",
      `printf 'end-${index}\\n' >> ${JSON.stringify(orderPath)}`,
      "printf 'BOUNDED_OK\\n'",
      "",
    ].join("\n"), "utf8");
    chmodSync(executable, 0o755);
    return testShellTool({
      exposeAs,
      smoke: { scope: "mount", args: ["--smoke"], marker: "BOUNDED_OK" },
    });
  });

  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      readableRoots: [mountRoot],
      writableRoots: [artifactRoot],
      shellTools,
    }),
    appServer: testAppServer(),
  });

  assert.equal(report.status, "passed");
  const order = readFileSync(orderPath, "utf8").trim().split("\n");
  const firstEnd = order.findIndex((entry) => entry.startsWith("end-"));
  const fifthStart = order.indexOf("start-4");
  assert.ok(firstEnd >= 0 && fifthStart > firstEnd);
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
      readableRoots: [mountRoot],
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

test("mount preflight serializes installs within the plugin-manager lock", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "scout-plugin-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mountRoot = join(root, "mount");
  const artifactRoot = join(root, "artifacts");
  mkdirSync(mountRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  const installed = new Set<string>();
  const installOrder: string[] = [];
  let activeInstalls = 0;
  let maxActiveInstalls = 0;
  const appServer = {
    request: async (method: string, params: unknown) => {
      if (method === "config/read") return { layers: [] };
      if (method === "skills/list") return { data: [] };
      if (method === "plugin/list") {
        return {
          marketplaces: [{
            name: "local",
            plugins: ["alpha", "beta"].map((name) => ({ name })),
          }],
        };
      }
      if (method === "plugin/installed") {
        return {
          marketplaces: [{
            name: "local",
            plugins: ["alpha", "beta"].map((name) => ({
              name,
              installed: installed.has(name),
              enabled: installed.has(name),
            })),
          }],
        };
      }
      if (method === "plugin/install") {
        const pluginName = (params as { pluginName: string }).pluginName;
        activeInstalls += 1;
        maxActiveInstalls = Math.max(maxActiveInstalls, activeInstalls);
        installOrder.push(pluginName);
        await new Promise((resolve) => setTimeout(resolve, 5));
        installed.add(pluginName);
        activeInstalls -= 1;
        return { pluginName, status: "installed" };
      }
      if (method === "hooks/list") return {};
      throw new Error(`unexpected app-server method: ${method}`);
    },
    withPluginManagerLock: async <T>(operation: () => Promise<T>) => operation(),
  } as unknown as CodexAppServerClient;

  const report = await preflightCodexAppServerMount({
    mount: testMount({
      root,
      mountRoot,
      artifactRoot,
      readableRoots: [mountRoot],
      writableRoots: [artifactRoot],
      plugins: ["alpha", "beta"],
    }),
    appServer,
  });

  assert.equal(report.status, "passed");
  assert.equal(maxActiveInstalls, 1);
  assert.deepEqual(installOrder, ["alpha", "beta"]);
});

test("preflight persistence keeps catalog state without device-local payloads", () => {
  const root = "/private/tmp/source-scout/run/run-portable";
  const mount = testMount({
    root,
    mountRoot: `${root}/agents/coordinator/mount`,
    artifactRoot: `${root}/agents/coordinator/artifacts`,
    readableRoots: [],
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
        access: "readable" as const,
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
    shellSmoke: [{
      command: "example --smoke",
      status: "passed" as const,
      durationMs: 12,
    }],
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
  assert.equal(summary.shellSmoke?.[0]?.durationMs, 12);
});

function testMount(input: {
  root: string;
  mountRoot: string;
  artifactRoot: string;
  readableRoots: string[];
  writableRoots: string[];
  plugins?: string[];
  shellTools?: ShellToolContract[];
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
      phase: "coordinate",
      shellTools: [],
      mcpServers: [],
      plugins: input.plugins ?? [],
      readableRoots: input.readableRoots,
      writableRoots: input.writableRoots,
    },
    assetCommitId: "ac_preflight",
    mountId: "m_preflight",
    scoutRoot: input.root,
    mountRoot: input.mountRoot,
    runRoot: input.root,
    artifactRoot: input.artifactRoot,
    logsRoot: join(input.root, "logs"),
    issues: [],
    readableRoots: input.readableRoots,
    writableRoots: input.writableRoots,
    shellTools: input.shellTools ?? [],
    mcpServers: [],
    customAgents: [],
    skills: [],
    plugins: input.plugins ?? [],
    manifestPath: join(input.mountRoot, "mount-manifest.json"),
    resourceHash: "resource-preflight",
  };
}

function testShellTool(input: {
  exposeAs: string;
  smoke?: ShellToolContract["smoke"];
}): ShellToolContract {
  return {
    id: input.exposeAs,
    name: input.exposeAs,
    command: input.exposeAs,
    exposeAs: input.exposeAs,
    required: true,
    ...(input.smoke ? { smoke: input.smoke } : {}),
  };
}

function testAppServer(): CodexAppServerClient {
  return {
    request: async () => ({}),
  } as unknown as CodexAppServerClient;
}

import { projectCurrentAgentWorkflow } from "../helpers/workflow-participant.js";
import { join } from "node:path";
import type { CodexAppServerClient } from "../../src/agent-server/codex/app-server-client.js";
import { AssetStore, type MaterializeOptions } from "../../src/asset-store/index.js";
import { InMemoryEventBus } from "../../src/core/events/index.js";
import type { Logger } from "../../src/core/logging/index.js";
import { Workflow } from "../../src/core/workflow/index.js";
import { NoopRuntimeInteractionPort } from "../../src/interaction/protocol/port.js";
import { RunManifestStore } from "../../src/run/persistence/index.js";
import { RestoreEnvironmentStage } from "../../src/run/resume/stages/restore-environment-stage.js";
import { installRunScope, RunScope } from "../../src/run/run-scope.js";
import { createDefaultTestGraph, createTestWorkflowAsset } from "../helpers/run-persistence.js";

const [scoutRoot, runId, crashAt, allowDrift] = process.argv.slice(2);
if (!scoutRoot || !runId || !crashAt) throw new Error("Missing environment crash fixture arguments.");

class CrashManifestStore extends RunManifestStore {
  override update(update: Parameters<RunManifestStore["update"]>[0]) {
    if (crashAt === "before-index") process.kill(process.pid, "SIGKILL");
    const manifest = super.update(update);
    if (crashAt === "after-index") process.kill(process.pid, "SIGKILL");
    return manifest;
  }

  override restore(manifest: Parameters<RunManifestStore["restore"]>[0]): void {
    super.restore(manifest);
    if (crashAt === "rollback") process.kill(process.pid, "SIGKILL");
  }
}

class CrashAssetStore extends AssetStore {
  override prepareMount(
    options: MaterializeOptions,
    observe?: MaterializeOptions["onMaterializationStep"],
  ) {
    return super.prepareMount(options, (step) => {
      observe?.(step);
      if (crashAt === "wipe" && options.agentId === "coordinator" && step === "wipe") {
        process.kill(process.pid, "SIGKILL");
      }
    });
  }
}

const runRoot = join(scoutRoot, "run", runId);
const assetStore = new CrashAssetStore();
const scope = new RunScope({
  scoutRoot,
  runRoot,
  runId,
  config: assetStore.config(scoutRoot),
  workflow: new Workflow(createTestWorkflowAsset(createDefaultTestGraph().snapshot())),
  manifestStore: new CrashManifestStore(runRoot),
  scoutConfig: {
    workflow: { profile: "validation" },
    restore: { allowAssetResourceDrift: allowDrift === "true" },
  },
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger,
  eventBus: new InMemoryEventBus(),
  interactionPort: new NoopRuntimeInteractionPort(),
  terminate: async () => undefined,
});
scope.setAppServer({} as CodexAppServerClient);
const release = installRunScope(scope);
try {
  await new RestoreEnvironmentStage({
    assetStore,
    preflightMount: async () => ({ status: "passed" }),
  }).start();
} finally {
  release();
}

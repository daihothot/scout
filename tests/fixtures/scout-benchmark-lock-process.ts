import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [runRoot, mode] = process.argv.slice(2);
if (!runRoot) throw new Error("Missing Scout benchmark lock fixture root.");

function announce(type: string, message?: string): void {
  fs.writeSync(1, `${JSON.stringify({ type, message, processId: process.pid })}\n`);
}

function waitForCommand(): string {
  const byte = Buffer.alloc(1);
  let command = "";
  while (fs.readSync(0, byte, 0, 1, null) !== 0) {
    if (byte[0] === 10) break;
    command += byte.toString("utf8");
  }
  return command;
}

if (mode === "pause-before-reclaim" || mode === "pause-before-publish" || mode === "pause-after-reclaim") {
  const link = fs.linkSync;
  fs.linkSync = (source, target) => {
    if (mode === "pause-before-reclaim" && target === join(runRoot, ".workflow.lock.reclaim")) {
      announce("reclaiming");
      if (waitForCommand() !== "continue") throw new Error("Reclamation was not released.");
    }
    if (mode === "pause-before-publish" && target === join(runRoot, ".workflow.lock")) {
      announce("publishing");
      if (waitForCommand() !== "continue") throw new Error("Publication was not released.");
    }
    link(source, target);
    if (mode === "pause-after-reclaim" && target === join(runRoot, ".workflow.lock.reclaim")) {
      announce("guarded");
      if (waitForCommand() !== "continue") throw new Error("Recovery guard was not released.");
    }
  };
  syncBuiltinESMExports();
}

const { WorkflowStorageLock, inspectWorkflowDirectory, createWorkflowDirectory } = await import("../../src/core/io/index.js");
const storage = new WorkflowStorageLock(runRoot);
announce("ready");
if (waitForCommand() !== "acquire") throw new Error("Acquisition was not requested.");
try {
  storage.acquire();
} catch (error) {
  announce("rejected", error instanceof Error ? error.message : String(error));
  process.exit(0);
}
const allocation = inspectWorkflowDirectory(storage, "workflow-001");
const prepared = createWorkflowDirectory(storage, allocation.location);
fs.writeFileSync(join(prepared.journalRoot, "holder.txt"), String(process.pid));
announce("acquired");
if (waitForCommand() !== "release") throw new Error("Release was not requested.");
storage.release();
announce("released");

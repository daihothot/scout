import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScoutAgentOptions } from "../core/scout-agent.js";

const COMMON_INSTRUCTIONS_FILE = "AGENTS.md";
const WORKER_INSTRUCTIONS_FILE = "agents/worker.AGENTS.md";

/** Returns the mounted instruction assets injected into one role. */
export function agentInstructionAssetPaths(isWorker: boolean): string[] {
  return isWorker
    ? [COMMON_INSTRUCTIONS_FILE, WORKER_INSTRUCTIONS_FILE]
    : [COMMON_INSTRUCTIONS_FILE];
}

/** Reads the global instructions from the prepared mount. */
export function readAgentInstructions(options: ScoutAgentOptions): string {
  return readFileSync(join(options.agentMount.mountRoot, COMMON_INSTRUCTIONS_FILE), "utf8");
}

/** Reads global and shared Worker instructions from the prepared mount. */
export function readWorkerAgentInstructions(options: ScoutAgentOptions): string {
  return [
    readAgentInstructions(options),
    readFileSync(join(options.agentMount.mountRoot, WORKER_INSTRUCTIONS_FILE), "utf8"),
  ].join("\n\n");
}

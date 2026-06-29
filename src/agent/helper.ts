import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScoutAgentOptions } from "./scout-agent.js";
import type { ScoutAgentRole } from "./types.js";

const AGENTS_DIR = "agents";
const WORKER_INSTRUCTIONS_FILE = "worker.AGENTS.md";

export function readRoleAgentInstructions(
  options: ScoutAgentOptions,
  role: ScoutAgentRole,
): string {
  return readFileSync(join(options.agentMount.mountRoot, AGENTS_DIR, `${role}.AGENTS.md`), "utf8");
}

export function readWorkerInstructions(options: ScoutAgentOptions): string {
  return readFileSync(join(options.agentMount.mountRoot, AGENTS_DIR, WORKER_INSTRUCTIONS_FILE), "utf8");
}

export function readWorkerRoleInstructions(
  options: ScoutAgentOptions,
  role: ScoutAgentRole,
): string {
  return [
    readWorkerInstructions(options),
    readRoleAgentInstructions(options, role),
  ].join("\n\n");
}

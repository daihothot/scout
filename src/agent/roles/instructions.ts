import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScoutAgentOptions } from "../core/scout-agent.js";
import type { ScoutAgentRole } from "../thread/types.js";

const AGENTS_DIR = "agents";
const COMMON_INSTRUCTIONS_FILE = "AGENTS.md";
const WORKER_INSTRUCTIONS_FILE = "worker.AGENTS.md";

export function readRoleAgentInstructions(
  options: ScoutAgentOptions,
  role: ScoutAgentRole,
): string {
  return [
    readCommonInstructions(options),
    readRoleInstructions(options, role),
  ].join("\n\n");
}

export function readWorkerInstructions(options: ScoutAgentOptions): string {
  return readFileSync(join(options.agentMount.mountRoot, AGENTS_DIR, WORKER_INSTRUCTIONS_FILE), "utf8");
}

export function readWorkerRoleInstructions(
  options: ScoutAgentOptions,
  role: ScoutAgentRole,
): string {
  return [
    readCommonInstructions(options),
    readWorkerInstructions(options),
    readRoleInstructions(options, role),
  ].join("\n\n");
}

function readCommonInstructions(options: ScoutAgentOptions): string {
  return readFileSync(join(options.agentMount.mountRoot, COMMON_INSTRUCTIONS_FILE), "utf8");
}

function readRoleInstructions(options: ScoutAgentOptions, role: ScoutAgentRole): string {
  return readFileSync(join(options.agentMount.mountRoot, AGENTS_DIR, `${role}.AGENTS.md`), "utf8");
}

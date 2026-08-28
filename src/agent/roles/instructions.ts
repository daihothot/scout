import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScoutAgentOptions } from "../core/scout-agent.js";

const COMMON_INSTRUCTIONS_FILE = "AGENTS.md";

/** Returns the mounted instruction asset shared by every role. */
export function agentInstructionAssetPaths(): string[] {
  return [COMMON_INSTRUCTIONS_FILE];
}

/** Reads the global instructions from the prepared mount. */
export function readAgentInstructions(options: ScoutAgentOptions): string {
  return readFileSync(join(options.agentMount.mountRoot, COMMON_INSTRUCTIONS_FILE), "utf8");
}

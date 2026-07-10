import { startRun } from "./index.js";
import { startScoutTui } from "../interaction/tui/run-tui.js";
import {
  readAgentProfilesForRepo,
  resolveDefaultAgentModel,
} from "../asset-store/agent-profiles.js";

export async function runScoutTui(input: {
  cwd: string;
}): Promise<void> {
  const defaultModel = resolveDefaultAgentModel(readAgentProfilesForRepo(input.cwd));
  const tui = startScoutTui({
    cwd: input.cwd,
    version: process.env.npm_package_version ?? "0.1.0",
    model: defaultModel.id,
    reasoningEffort: defaultModel.reasoningEffort,
  });
  try {
    const result = await startRun({
      cwd: input.cwd,
      interactionPort: tui.interactionPort,
    });
    tui.store.setRun({
      runId: result.runId,
      status: result.status === "passed" ? "ready" : "failed",
    });
  } catch (error) {
    tui.store.setRun({ status: "failed" });
    tui.store.addDisclosure({
      level: "error",
      source: "tui",
      message: "Scout run failed.",
      data: {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
    });
  }
  await tui.waitUntilExit();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runScoutTui({
    cwd: process.cwd(),
  });
}

import { resumeRun, startRun } from "./index.js";
import { startScoutTui } from "../interaction/tui/run-tui.js";
import { readWorkflowProfile } from "../asset-store/assets/workflow-profiles.js";
import { loadScoutConfig } from "../system/config/index.js";

/** Starts either a new or resumed run and keeps the TUI alive for disclosure. */
export async function runScoutTui(input: {
  cwd: string;
  resume?: string;
}): Promise<void> {
  const scoutConfig = loadScoutConfig(input.cwd);
  const defaultModel = readWorkflowProfile(
    input.cwd,
    scoutConfig.workflow.profile,
  ).profile.defaults.model;
  const tui = startScoutTui({
    cwd: input.cwd,
    version: process.env.npm_package_version ?? "0.1.0",
    model: defaultModel.id,
    reasoningEffort: defaultModel.reasoningEffort,
  });
  try {
    const result = input.resume
      ? await resumeRun({
        cwd: input.cwd,
        run: input.resume,
        interactionPort: tui.interactionPort,
      })
      : await startRun({
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
  const args = process.argv.slice(2);
  if (args.length > 0 && (args[0] !== "resume" || !args[1] || args.length > 2)) {
    throw new Error("Usage: scout | scout resume <runId|runDir>");
  }
  await runScoutTui({
    cwd: process.cwd(),
    resume: args[0] === "resume" ? args[1] : undefined,
  });
}

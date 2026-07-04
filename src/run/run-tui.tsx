import { startRun } from "./index.js";
import { startScoutTui } from "../interaction/tui/run-tui.js";

export async function runScoutTui(input: {
  cwd: string;
}): Promise<void> {
  const tui = startScoutTui();
  try {
    await startRun({
      cwd: input.cwd,
      interactionPort: tui.interactionPort,
    });
  } catch (error) {
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

import {
  RunJournalWriter,
} from "../../journal/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../run-stage.js";

/** Attaches the journal writer and closes the run journal on shutdown. */
export class RunJournalWriterStage implements RunStage {
  readonly id = "run_journal_writer";
  private writer?: RunJournalWriter;

  async start(): Promise<void> {
    const writer = new RunJournalWriter();
    writer.start();
    this.writer = writer;
  }

  async stop(): Promise<void> {
    try {
      this.writer?.stop();
      this.writer = undefined;
    } finally {
      currentRunScope().journal.close();
    }
  }
}

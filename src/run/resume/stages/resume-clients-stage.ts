import {
  RunAppServerStage,
  type RunStage,
} from "../../lifecycle/index.js";

export class ResumeClientsStage implements RunStage {
  readonly id = "restore_clients";
  private stage?: RunAppServerStage;

  async start(): Promise<void> {
    const stage = new RunAppServerStage();
    await stage.start();
    this.stage = stage;
  }

  async stop(reason: string): Promise<void> {
    await this.stage?.stop();
    this.stage = undefined;
  }
}

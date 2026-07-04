import type { AgentTaskStore } from "../task/agent-task-store.js";
import type {
  AgentTaskState,
  AssignAgentTaskInput,
} from "../task/types.js";
import { ScoutAgent, type ScoutAgentOptions } from "../core/scout-agent.js";
import type { AgentThreadSpec } from "../thread/types.js";
import { WorkerRunner } from "../runner/worker/worker-runner.js";

export abstract class WorkerAgent extends ScoutAgent {
  declare runner: WorkerRunner;
  private readonly workerTaskStore: AgentTaskStore;

  constructor(options: ScoutAgentOptions & { spec: AgentThreadSpec }) {
    super(options);
    this.workerTaskStore = options.taskStore;
    this.runner = this.createWorkerRunner();
  }

  assignTask(input: AssignAgentTaskInput): AgentTaskState {
    this.runner.stop("runner_replaced");
    this.runner = this.createWorkerRunner(input);
    const task = this.runner.snapshot().activeTask;
    if (!task) {
      throw new Error(`Worker agent ${this.agentId} failed to initialize assigned task.`);
    }
    return task;
  }

  private createWorkerRunner(taskInput?: AssignAgentTaskInput): WorkerRunner {
    const worker = this;
    return new WorkerRunner({
      store: this.workerTaskStore,
      eventBus: this.eventBus,
      taskInput,
      host: {
        get agentId() {
          return worker.agentId;
        },
        get role() {
          return worker.role;
        },
        get spec() {
          return worker.spec;
        },
        get threadSnapshot() {
          return worker.threadSnapshot;
        },
        logger: this.logger,
        runTurn: (turnInput) => worker.runTurn(turnInput),
        setGoal: (goalInput) => worker.setGoal(goalInput),
      },
    });
  }
}

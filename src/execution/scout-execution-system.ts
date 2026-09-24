import {
  IdentifyExecutionCommand,
  LaunchExecutionCommand,
  ShutdownExecutionCommand,
} from "./commands/index.js";
import {
  InMemoryEventBus,
  type EventBus,
  type EventType,
} from "../core/events/index.js";
import type {
  ExecutionCommand,
  ExecutionCommandResult,
  ExecutionOperationOptions,
  ExecutionPlatformFailure,
  ExecutionPlatformIdentifyResult,
  ExecutionPlatformLaunchResult,
  ExecutionPlatformPort,
  ExecutionPlatformRequest,
  ExecutionPlatformShutdownResult,
} from "./execution-command.js";
import {
  ExecutionEvents,
  type ExecutionCommandCompletedEvent,
} from "./execution-events.js";
import type { ExecutionHandler } from "./execution-handler.js";

export type {
  ExecutionPlatformFailure,
  ExecutionPlatformIdentity,
  ExecutionPlatformIdentifyResult,
  ExecutionPlatformLaunchResult,
  ExecutionPlatformPort,
  ExecutionPlatformRequest,
  ExecutionPlatformShutdownResult,
} from "./execution-command.js";

/** Registers and serializes physical execution semantics over one Handler boundary. */
export class ScoutExecutionSystem implements ExecutionPlatformPort {
  private readonly commands = new Map<string, ExecutionCommand>();
  private operationTail: Promise<void> = Promise.resolve();
  private disposePromise?: Promise<void>;
  private correlationSequence = 0;
  private disposed = false;

  private constructor(
    private readonly handler: ExecutionHandler,
    private readonly eventBus: EventBus,
  ) {}

  static async start(
    handler: ExecutionHandler,
    eventBus: EventBus = new InMemoryEventBus(),
  ): Promise<ScoutExecutionSystem> {
    const system = new ScoutExecutionSystem(handler, eventBus);
    try {
      await handler.start();
      system.registerCommands();
      return system;
    } catch (error) {
      await handler.close();
      throw error;
    }
  }

  identify(
    request: ExecutionPlatformRequest = {},
    options: ExecutionOperationOptions = {},
  ): Promise<ExecutionPlatformIdentifyResult> {
    if (this.disposed) return Promise.resolve(disposedFailure());
    return this.enqueue(async () => {
      const result = await this.invokeAndPublish(
        "identify",
        request,
        request,
        options,
        ExecutionEvents.execution.identifyCompleted,
      );
      return result.ok
        ? { ok: true, identity: structuredClone(result.selection.platform) }
        : result;
    });
  }

  launch(
    request: ExecutionPlatformRequest,
    options: ExecutionOperationOptions = {},
  ): Promise<ExecutionPlatformLaunchResult> {
    if (this.disposed) return Promise.resolve(disposedFailure());
    return this.enqueue(async () => {
      const result = await this.invokeAndPublish(
        "launch",
        request,
        request,
        options,
        ExecutionEvents.execution.launchCompleted,
      );
      return result.ok
        ? { ok: true, identity: structuredClone(result.selection.platform) }
        : result;
    });
  }

  shutdown(
    request: ExecutionPlatformRequest,
    options: ExecutionOperationOptions = {},
  ): Promise<ExecutionPlatformShutdownResult> {
    if (this.disposed) return Promise.resolve(disposedFailure());
    return this.enqueue(async () => {
      const result = await this.invokeAndPublish(
        "shutdown",
        request,
        request,
        options,
        ExecutionEvents.execution.shutdownCompleted,
      );
      return result.ok
        ? { ok: true, identity: structuredClone(result.selection.platform) }
        : result;
    });
  }

  /** Closes the run-owned Handler after queued semantics have completed. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.enqueue(() => this.handler.close());
    return this.disposePromise;
  }

  private registerCommands(): void {
    const identify = new IdentifyExecutionCommand(this.handler);
    this.register(identify);
    this.register(new LaunchExecutionCommand(this.handler));
    this.register(new ShutdownExecutionCommand(this.handler));
  }

  private register(command: ExecutionCommand): void {
    if (this.commands.has(command.operation)) {
      throw new Error(`Execution command ${command.operation} is already registered.`);
    }
    this.commands.set(command.operation, command);
  }

  private invoke(operation: string, input: unknown): Promise<ExecutionCommandResult> {
    const command = this.commands.get(operation);
    return command
      ? command.invoke(input)
      : Promise.resolve({
        ok: false,
        code: "execution_command_not_registered",
        message: `Execution command ${operation} is not registered.`,
      });
  }

  private async invokeAndPublish(
    operation: string,
    input: unknown,
    request: ExecutionPlatformRequest,
    options: ExecutionOperationOptions,
    eventType: EventType<ExecutionCommandCompletedEvent>,
  ): Promise<ExecutionCommandResult> {
    const result = await this.invoke(operation, input);
    await this.eventBus.publishAndWait(eventType, {
      correlationId: options.correlationId ?? this.nextCorrelationId(operation),
      request: structuredClone(request),
      result: structuredClone(result),
    });
    return result;
  }

  private nextCorrelationId(operation: string): string {
    this.correlationSequence += 1;
    return `execution-${operation}-${String(this.correlationSequence).padStart(6, "0")}`;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function disposedFailure(): ExecutionPlatformFailure {
  return {
    ok: false,
    code: "execution_system_disposed",
    message: "The Scout execution system has been disposed.",
  };
}

import type { ExecutionAdapter } from "./execution-adapter-registry.js";
import { ExecutionAdapterRegistry } from "./execution-adapter-registry.js";
import type {
  ExecutionPlatformFailure,
  ExecutionPlatformIdentity,
  ExecutionPlatformLaunchResult,
  ExecutionPlatformPort,
  ExecutionPlatformShutdownResult,
} from "./execution-platform-port.js";

interface ExecutionSession {
  identity: ExecutionPlatformIdentity;
  adapter: ExecutionAdapter;
}

/** Owns the current run's execution session and hides its transport adapter. */
export class ScoutExecutionSystem implements ExecutionPlatformPort {
  private session?: ExecutionSession;
  private operationTail: Promise<void> = Promise.resolve();
  private disposePromise?: Promise<void>;
  private disposed = false;

  constructor(private readonly registry: ExecutionAdapterRegistry) {}

  launch(): Promise<ExecutionPlatformLaunchResult> {
    if (this.disposed) return Promise.resolve(disposedFailure());
    return this.enqueue(async () => {
      const ensured = await this.ensureSession();
      if (!ensured.ok) return ensured;
      const session = ensured.session;
      const launched = await session.adapter.launch(session.identity);
      return launched.ok
        ? { ok: true, identity: structuredClone(session.identity) }
        : launched;
    });
  }

  shutdown(): Promise<ExecutionPlatformShutdownResult> {
    if (this.disposed) return Promise.resolve(disposedFailure());
    return this.enqueue(async () => {
      const ensured = await this.ensureSession();
      if (!ensured.ok) return ensured;
      const session = ensured.session;
      const stopped = await session.adapter.shutdown(session.identity);
      if (!stopped.ok) return stopped;
      this.session = undefined;
      return { ok: true, identity: structuredClone(session.identity) };
    });
  }

  /** Stops only an already-owned session; lifecycle teardown never discovers a new platform. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.enqueue(async () => {
      const session = this.session;
      if (!session) return;
      const stopped = await session.adapter.shutdown(session.identity);
      if (!stopped.ok) {
        throw new Error(`${stopped.code}: ${stopped.message}`);
      }
      this.session = undefined;
    });
    return this.disposePromise;
  }

  private async ensureSession(): Promise<
    | { ok: true; session: ExecutionSession }
    | ExecutionPlatformFailure
  > {
    if (this.session) return { ok: true, session: this.session };

    const selected = await this.registry.handshake();
    if (!selected.ok) return selected;
    this.session = {
      identity: structuredClone(selected.identity),
      adapter: selected.adapter,
    };
    return { ok: true, session: this.session };
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

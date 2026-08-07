import type {
  RuntimeInteractionPort,
  SubprocessProgressDescriptor,
  SubprocessProgressPhase,
  SubprocessProgressSnapshot,
} from "../../interaction/protocol/port.js";

/** Partial state accepted for one atomic subprocess progress transition. */
export interface SubprocessProgressUpdate {
  phase?: SubprocessProgressPhase;
  completedUnits?: number;
  totalUnits?: number;
  descriptor?: SubprocessProgressDescriptor;
}

/** Transport boundary used to publish immutable progress snapshots in order. */
export interface SubprocessProgressPublisher {
  publish(snapshot: SubprocessProgressSnapshot): Promise<void>;
}

/**
 * Keeps operation state independent from its transport and presentation.
 * Callers own the descriptor and update it whenever the operation advances.
 */
export class SubprocessProgressController {
  private current: SubprocessProgressSnapshot;

  constructor(options: {
    id: string;
    descriptor: SubprocessProgressDescriptor;
    totalUnits: number;
    completedUnits?: number;
  }) {
    this.current = {
      id: options.id,
      phase: "running",
      completedUnits: options.completedUnits ?? 0,
      totalUnits: options.totalUnits,
      descriptor: cloneDescriptor(options.descriptor),
    };
  }

  get snapshot(): SubprocessProgressSnapshot {
    return cloneSnapshot(this.current);
  }

  update(update: SubprocessProgressUpdate): SubprocessProgressSnapshot {
    this.current = {
      ...this.current,
      ...update,
      descriptor: update.descriptor
        ? cloneDescriptor(update.descriptor)
        : this.current.descriptor,
    };
    return this.snapshot;
  }

  complete(descriptor?: SubprocessProgressDescriptor): SubprocessProgressSnapshot {
    return this.update({
      phase: "done",
      completedUnits: this.current.totalUnits,
      descriptor,
    });
  }

  fail(descriptor: SubprocessProgressDescriptor): SubprocessProgressSnapshot {
    return this.update({ phase: "failed", descriptor });
  }
}

/** Creates isolated subprocess state; callers own its operation descriptor. */
export function createSubprocessProgress(options: {
  id: string;
  descriptor: SubprocessProgressDescriptor;
  totalUnits: number;
  completedUnits?: number;
}): SubprocessProgressController {
  return new SubprocessProgressController(options);
}

/**
 * Serializes transport writes and clones each snapshot so concurrent role
 * callbacks cannot publish mutable or out-of-order state to the TUI.
 */
export function createSubprocessProgressPublisher(
  interactionPort: RuntimeInteractionPort,
): SubprocessProgressPublisher {
  let tail = Promise.resolve();
  return {
    publish(snapshot) {
      const immutable = cloneSnapshot(snapshot);
      const next = tail.catch(() => undefined).then(() =>
        interactionPort.publishSubprocessProgress(immutable)
      );
      tail = next;
      return next;
    },
  };
}

function cloneSnapshot(snapshot: SubprocessProgressSnapshot): SubprocessProgressSnapshot {
  return {
    ...snapshot,
    descriptor: cloneDescriptor(snapshot.descriptor),
  };
}

function cloneDescriptor(descriptor: SubprocessProgressDescriptor): SubprocessProgressDescriptor {
  return {
    status: { ...descriptor.status },
    progress: descriptor.progress ? { ...descriptor.progress } : undefined,
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubprocessProgress,
  createSubprocessProgressPublisher,
} from "../../src/run/progress/index.js";
import {
  NoopRuntimeInteractionPort,
  type SubprocessProgressSnapshot,
} from "../../src/interaction/protocol/port.js";

test("SubprocessProgressController owns state while callers provide descriptors", () => {
  const descriptor = {
    status: {
      marker: "*",
      label: "Preparing runtime",
      detail: "Indexing",
      tone: "active" as const,
    },
    progress: {
      marker: "▷",
      label: "workspace",
      detail: "indexing",
      units: "1/3",
      tone: "active" as const,
    },
  };
  const controller = createSubprocessProgress({
    id: "index",
    totalUnits: 3,
    descriptor,
  });

  descriptor.status.detail = "mutated";
  assert.equal(controller.snapshot.descriptor.status.detail, "Indexing");

  const running = controller.update({
    completedUnits: 2,
    descriptor: {
      ...controller.snapshot.descriptor,
      progress: { ...controller.snapshot.descriptor.progress!, units: "2/3" },
    },
  });
  assert.equal(running.phase, "running");
  assert.equal(running.completedUnits, 2);
  assert.equal(running.descriptor.progress?.units, "2/3");

  const done = controller.complete({
    status: { marker: "*", label: "Runtime ready", tone: "success" },
  });
  assert.equal(done.phase, "done");
  assert.equal(done.completedUnits, 3);
  assert.equal(done.descriptor.progress, undefined);
});

test("SubprocessProgressPublisher serializes snapshots and clones descriptors", async () => {
  class CapturingPort extends NoopRuntimeInteractionPort {
    readonly received: SubprocessProgressSnapshot[] = [];

    override async publishSubprocessProgress(snapshot: SubprocessProgressSnapshot): Promise<void> {
      this.received.push(snapshot);
    }
  }

  const port = new CapturingPort();
  const publisher = createSubprocessProgressPublisher(port);
  const first: SubprocessProgressSnapshot = {
    id: "operation",
    phase: "running",
    completedUnits: 1,
    totalUnits: 2,
    descriptor: {
      status: { label: "Working", tone: "active" },
    },
  };
  const second: SubprocessProgressSnapshot = {
    ...first,
    completedUnits: 2,
    phase: "done",
    descriptor: {
      status: { label: "Done", tone: "success" },
    },
  };

  await Promise.all([publisher.publish(first), publisher.publish(second)]);

  assert.deepEqual(
    port.received.map((snapshot) => [snapshot.completedUnits, snapshot.phase]),
    [[1, "running"], [2, "done"]],
  );
  first.descriptor.status.label = "changed";
  assert.equal(port.received[0]?.descriptor.status.label, "Working");
});

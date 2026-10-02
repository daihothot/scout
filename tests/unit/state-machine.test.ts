import assert from "node:assert/strict";
import test from "node:test";
import { StateMachine } from "../../src/core/state/statemachine/index.js";

test("StateMachine awaits entry, exit, and the registered transition in order", async () => {
  const machine = new StateMachine<"idle" | "running", string[]>();
  const trace: string[] = [];
  machine.register("idle", {
    async enter(log) { await Promise.resolve(); log.push("idle.enter"); },
    exit(log) { log.push("idle.exit"); },
  }, {
    in(log) { log.push("idle.in"); },
    async out(log) { await Promise.resolve(); log.push("idle.out"); },
  });
  machine.register("running", {
    enter(log) { log.push("running.enter"); },
    exit(log) { log.push("running.exit"); },
  }, { in(log) { log.push("running.in"); }, out(log) { log.push("running.out"); } });
  await machine.enterState("idle", trace);
  await machine.enterState("running", trace);
  assert.deepEqual(trace, ["idle.in", "idle.enter", "idle.exit", "idle.out", "running.in", "running.enter"]);
  assert.equal(machine.currentState, "running");
});

test("StateMachine follows a returned successor without reentrant entry", async () => {
  const machine = new StateMachine<"creating" | "running", string[]>();
  const trace: string[] = [];
  machine.register("creating", {
    enter(log) { log.push("create"); return "running"; }, exit(log) { log.push("created.exit"); },
  });
  machine.register("running", { enter(log) { log.push("run"); }, exit() {} });
  await machine.enterState("creating", trace);
  assert.deepEqual(trace, ["create", "created.exit", "run"]);
  assert.equal(machine.currentState, "running");
});

test("StateMachine rejects overlapping transitions and drain awaits their lifetime", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const machine = new StateMachine<"waiting", undefined>();
  machine.register("waiting", { enter() { return barrier; }, exit() {} });
  const entered = machine.enterState("waiting", undefined);
  await assert.rejects(machine.enterState("waiting", undefined), /transitioning/);
  let drained = false;
  const drain = machine.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release();
  await Promise.all([entered, drain]);
  assert.equal(machine.transitioning, false);
});

test("StateMachine propagates failed entry without claiming success or rolling back domain work", async () => {
  const machine = new StateMachine<"creating" | "aborting", string[]>();
  const trace: string[] = [];
  machine.register("creating", {
    enter(log) { log.push("committed"); throw new Error("entry failed"); }, exit() {},
  });
  machine.register("aborting", { enter(log) { log.push("abort"); }, exit() {} });
  await assert.rejects(machine.enterState("creating", trace), /entry failed/);
  assert.equal(machine.currentState, undefined, "failed entry is not an entered state");
  assert.deepEqual(trace, ["committed"]);
  await machine.enterState("aborting", trace);
  assert.deepEqual(trace, ["committed", "abort"]);
});

test("StateMachine rejects an unregistered target before exiting the current state", async () => {
  const machine = new StateMachine<"idle" | "missing", string[]>();
  const trace: string[] = [];
  machine.register("idle", { enter() {}, exit(log) { log.push("exit"); } });
  await machine.enterState("idle", trace);
  await assert.rejects(machine.enterState("missing", trace), /not registered/);
  assert.equal(machine.currentState, "idle");
  assert.deepEqual(trace, []);
});

test("StateMachine does not enter the destination when its pre-entry transaction fails", async () => {
  const machine = new StateMachine<"idle" | "creating", string[]>();
  const trace: string[] = [];
  machine.register("idle", { enter() {}, exit(log) { log.push("idle.exit"); } }, {
    in() {}, out(log) { log.push("idle.out"); },
  });
  machine.register("creating", { enter(log) { log.push("create"); }, exit() {} }, {
    in(log) { log.push("creating.in"); throw new Error("preparation failed"); }, out() {},
  });
  await machine.enterState("idle", trace);
  await assert.rejects(machine.enterState("creating", trace), /preparation failed/);
  assert.equal(machine.currentState, undefined, "the old state exited; the new state never entered");
  assert.deepEqual(trace, ["idle.exit", "idle.out", "creating.in"]);
});

test("StateMachine preserves a failed exit and does not run later transactions", async () => {
  const machine = new StateMachine<"running" | "closing", string[]>();
  const trace: string[] = [];
  machine.register("running", { enter() {}, exit() { throw new Error("exit failed"); } }, {
    in() {}, out(log) { log.push("out"); },
  });
  machine.register("closing", { enter(log) { log.push("close"); }, exit() {} });
  await machine.enterState("running", trace);
  await assert.rejects(machine.enterState("closing", trace), /exit failed/);
  assert.equal(machine.currentState, "running");
  assert.deepEqual(trace, []);
});

test("StateMachine forwards the new migration payload, not the previous entry payload", async () => {
  const machine = new StateMachine<"idle" | "running", { name: string }>();
  const previousPayload = { name: "previous" };
  const nextPayload = { name: "next" };
  const observed: Array<{ name: string }> = [];
  machine.register("idle", { enter() {}, exit(payload) { observed.push(payload); } }, {
    in() {}, out(payload) { observed.push(payload); },
  });
  machine.register("running", { enter(payload) { observed.push(payload); }, exit() {} }, {
    in(payload) { observed.push(payload); }, out() {},
  });
  await machine.enterState("idle", previousPayload);
  await machine.enterState("running", nextPayload);
  assert.equal(observed.length, 4);
  for (const payload of observed) assert.equal(payload, nextPayload);
});

test("StateMachine awaits registered successor transactions with the same migration payload", async () => {
  const machine = new StateMachine<"creating" | "running", { name: string }>();
  const payload = { name: "start" };
  const trace: string[] = [];
  machine.register("creating", {
    enter(input) { assert.equal(input, payload); trace.push("create"); return "running"; },
    exit(input) { assert.equal(input, payload); trace.push("exit"); },
  }, {
    async in(input) { assert.equal(input, payload); await Promise.resolve(); trace.push("in"); },
    async out(input) { assert.equal(input, payload); await Promise.resolve(); trace.push("out"); },
  });
  machine.register("running", {
    enter(input) { assert.equal(input, payload); trace.push("run"); }, exit() {},
  });
  await machine.enterState("creating", payload);
  assert.deepEqual(trace, ["in", "create", "exit", "out", "run"]);
});

test("StateMachine does not re-exit an exited state or enter the target after a failed out transaction", async () => {
  const machine = new StateMachine<"closing" | "idle", undefined>();
  const trace: string[] = [];
  machine.register("closing", { enter() {}, exit() { trace.push("closing.exit"); } }, {
    in() {}, out() { trace.push("closing.out"); throw new Error("release failed"); },
  });
  machine.register("idle", { enter() { trace.push("idle.enter"); }, exit() {} });
  await machine.enterState("closing", undefined);
  await assert.rejects(machine.enterState("idle", undefined), /release failed/);
  assert.equal(machine.currentState, undefined);
  assert.deepEqual(trace, ["closing.exit", "closing.out"]);
  await machine.enterState("idle", undefined);
  assert.deepEqual(trace, ["closing.exit", "closing.out", "idle.enter"]);
});

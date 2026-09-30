import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Benchmarks } from "../../src/core/benchmarks/index.js";
import { ScoutBenchmarks } from "../../src/core/benchmarks/scout-benchmarks.js";

interface FixtureMessage {
  type: string;
  processId: number;
  message?: string;
}

function fixture(t: TestContext) {
  const runRoot = mkdtempSync(join(tmpdir(), "scout-workflow-lock-"));
  const processes: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<unknown> }> = [];
  t.after(async () => {
    for (const { child } of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(processes.map(({ closed }) => closed));
    rmSync(runRoot, { recursive: true, force: true });
  });
  const launch = (mode = "hold") => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../fixtures/scout-benchmark-lock-process.js", import.meta.url)),
      runRoot,
      mode,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(child, "close");
    processes.push({ child, closed });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const messages: FixtureMessage[] = [];
    const readers: Array<(message: FixtureMessage) => void> = [];
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as FixtureMessage;
      const reader = readers.shift();
      if (reader) reader(message);
      else messages.push(message);
    });
    return {
      child,
      closed,
      command: (command: string) => child.stdin.write(`${command}\n`),
      next: async (): Promise<FixtureMessage> => {
        const message = messages.shift();
        if (message) return message;
        return Promise.race([
          new Promise<FixtureMessage>((resolve) => readers.push(resolve)),
          closed.then(() => { throw new Error(`Workflow lock fixture exited without a message: ${stderr}`); }),
        ]);
      },
    };
  };
  return { runRoot, launch, lockPath: join(runRoot, ".workflow.lock") };
}

test("Workflow benchmark mutations require their own root lease while reads remain available", (t) => {
  const { runRoot } = fixture(t);
  const owner = new ScoutBenchmarks(new Benchmarks(runRoot));
  const observer = new ScoutBenchmarks(new Benchmarks(runRoot));
  assert.equal(observer.read(), undefined);
  assert.throws(() => observer.prepareNext(), /must be acquired before mutation/);
  owner.benchmarks.acquire();
  owner.benchmarks.acquire();
  try {
    const prepared = owner.prepareNext();
    owner.recordStarted(prepared.workflowId);
    assert.equal(observer.resolve("currentWorkflow")?.workflowId, prepared.workflowId);
    assert.throws(() => observer.benchmarks.acquire(), /already attached/);
    assert.throws(() => observer.recordRun(prepared.workflowId), /must be acquired before mutation/);
    assert.throws(() => observer.recordSuccess(prepared.workflowId), /must be acquired before mutation/);
    assert.throws(() => observer.recordStarted(prepared.workflowId), /must be acquired before mutation/);
    assert.throws(() => observer.discard(prepared), /must be acquired before mutation/);
    observer.benchmarks.release();
    owner.recordSuccess(prepared.workflowId);
  } finally {
    owner.benchmarks.release();
  }
  observer.benchmarks.acquire();
  observer.benchmarks.release();
  observer.benchmarks.release();
});

test("Two actual processes cannot overwrite each other's uncommitted Workflow directory", { timeout: 15_000 }, async (t) => {
  const { launch, runRoot, lockPath } = fixture(t);
  const left = launch();
  const right = launch();
  assert.equal((await left.next()).type, "ready");
  assert.equal((await right.next()).type, "ready");
  left.command("acquire");
  right.command("acquire");
  const results = await Promise.all([left.next(), right.next()]);
  assert.deepEqual(results.map(({ type }) => type).sort(), ["acquired", "rejected"]);
  const winner = results[0].type === "acquired" ? left : right;
  const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { processId: number };
  assert.equal(owner.processId, winner.child.pid);
  assert.equal(readFileSync(join(runRoot, "workflows", "workflow-001", "journal", "holder.txt"), "utf8"), String(winner.child.pid));
  winner.command("release");
  assert.equal((await winner.next()).type, "released");
  assert.equal(existsSync(lockPath), false);
});

test("A SIGKILLed root owner can be reclaimed without deleting its historical Workflow", { timeout: 15_000 }, async (t) => {
  const { runRoot, launch, lockPath } = fixture(t);
  const holder = launch();
  await holder.next();
  holder.command("acquire");
  assert.equal((await holder.next()).type, "acquired");
  const contents = readFileSync(lockPath, "utf8");
  holder.child.kill("SIGKILL");
  await holder.closed;
  const next = new ScoutBenchmarks(new Benchmarks(runRoot));
  next.benchmarks.acquire();
  try {
    assert.notEqual(readFileSync(lockPath, "utf8"), contents);
    assert.equal(readFileSync(join(runRoot, "workflows", "workflow-001", "journal", "holder.txt"), "utf8"), String(holder.child.pid));
    assert.equal(existsSync(`${lockPath}.reclaim`), false);
  } finally {
    next.benchmarks.release();
  }
});

test("Root owner publication exposes only a complete record and never replaces a competing owner", { timeout: 15_000 }, async (t) => {
  const { launch, lockPath } = fixture(t);
  const delayed = launch("pause-before-publish");
  await delayed.next();
  delayed.command("acquire");
  assert.equal((await delayed.next()).type, "publishing");
  assert.equal(existsSync(lockPath), false);
  const winner = launch();
  await winner.next();
  winner.command("acquire");
  assert.equal((await winner.next()).type, "acquired");
  const contents = readFileSync(lockPath, "utf8");
  const owner = JSON.parse(contents) as Record<string, unknown>;
  assert.equal(owner.version, 1);
  assert.equal(owner.hostId, hostname());
  assert.equal(owner.processId, winner.child.pid);
  assert.equal(typeof owner.token, "string");
  assert.equal(typeof owner.acquiredAt, "string");
  delayed.command("continue");
  const rejected = await delayed.next();
  assert.equal(rejected.type, "rejected");
  assert.match(rejected.message!, /already attached/);
  assert.equal(readFileSync(lockPath, "utf8"), contents);
  winner.command("release");
  assert.equal((await winner.next()).type, "released");
});

test("A delayed second stale reclaimer cannot unlink the first reclaimer's new live root lock", { timeout: 15_000 }, async (t) => {
  const { runRoot, launch, lockPath } = fixture(t);
  const dead = launch();
  await dead.next();
  dead.command("acquire");
  await dead.next();
  dead.child.kill("SIGKILL");
  await dead.closed;
  const first = launch("pause-before-reclaim");
  const second = launch("pause-before-reclaim");
  await Promise.all([first.next(), second.next()]);
  first.command("acquire");
  second.command("acquire");
  assert.equal((await first.next()).type, "reclaiming");
  assert.equal((await second.next()).type, "reclaiming");
  first.command("continue");
  assert.equal((await first.next()).type, "acquired");
  const activeOwner = readFileSync(lockPath, "utf8");
  second.command("continue");
  const rejected = await second.next();
  assert.equal(rejected.type, "rejected");
  assert.match(rejected.message!, /lock changed during stale recovery/);
  assert.equal(readFileSync(lockPath, "utf8"), activeOwner);
  assert.equal(readFileSync(join(runRoot, "workflows", "workflow-001", "journal", "holder.txt"), "utf8"), String(first.child.pid));
  first.command("release");
  assert.equal((await first.next()).type, "released");
});

test("Unverifiable or remote root lock owners fail closed and their files remain intact", (t) => {
  const { runRoot, lockPath } = fixture(t);
  mkdirSync(runRoot, { recursive: true });
  const owner = {
    version: 1,
    hostId: `${hostname()}-remote`,
    processId: process.pid,
    token: "remote-owner",
    acquiredAt: new Date().toISOString(),
  };
  for (const contents of ["", "{", JSON.stringify({ processId: -1 }), JSON.stringify(owner)]) {
    writeFileSync(lockPath, contents);
    assert.throws(() => new ScoutBenchmarks(new Benchmarks(runRoot)).benchmarks.acquire(), /refusing.*recovery/);
    assert.equal(readFileSync(lockPath, "utf8"), contents);
  }
});

test("A stranded recovery guard blocks automatic acquisition even when the root lock is absent", (t) => {
  const { runRoot, lockPath } = fixture(t);
  mkdirSync(runRoot, { recursive: true });
  const guardPath = `${lockPath}.reclaim`;
  writeFileSync(guardPath, "unverifiable interrupted reclamation");
  assert.throws(() => new ScoutBenchmarks(new Benchmarks(runRoot)).benchmarks.acquire(), (error) => error instanceof Error
    && error.message.includes(guardPath)
    && error.message.includes("manually verify")
    && error.message.includes("do not remove"));
  assert.equal(readFileSync(guardPath, "utf8"), "unverifiable interrupted reclamation");
  assert.equal(existsSync(lockPath), false);
});

test("SIGKILL during stale-owner reclamation retains its guard and fails closed on the next attempt", { timeout: 15_000 }, async (t) => {
  const { runRoot, launch, lockPath } = fixture(t);
  const dead = launch();
  await dead.next();
  dead.command("acquire");
  await dead.next();
  dead.child.kill("SIGKILL");
  await dead.closed;
  const previous = readFileSync(lockPath, "utf8");
  const reclaimer = launch("pause-after-reclaim");
  await reclaimer.next();
  reclaimer.command("acquire");
  assert.equal((await reclaimer.next()).type, "guarded");
  reclaimer.child.kill("SIGKILL");
  await reclaimer.closed;
  assert.throws(() => new ScoutBenchmarks(new Benchmarks(runRoot)).benchmarks.acquire(), /recovery guard already exists.*manually verify/);
  assert.equal(readFileSync(lockPath, "utf8"), previous);
  assert.equal(existsSync(`${lockPath}.reclaim`), true);
});

test("A runtime whose lock token was replaced cannot mutate or unlink the replacement", (t) => {
  const { runRoot, lockPath } = fixture(t);
  const benchmarks = new ScoutBenchmarks(new Benchmarks(runRoot));
  benchmarks.benchmarks.acquire();
  const original = readFileSync(lockPath, "utf8");
  const replacement = JSON.stringify({ ...JSON.parse(original), token: "different-owner" });
  writeFileSync(lockPath, replacement);
  assert.throws(() => benchmarks.prepareNext(), /no longer owned/);
  assert.throws(() => benchmarks.benchmarks.release(), /no longer owned/);
  assert.equal(readFileSync(lockPath, "utf8"), replacement);
  writeFileSync(lockPath, original);
  benchmarks.benchmarks.release();
});

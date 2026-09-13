import assert from "node:assert/strict";
import test from "node:test";
import { HostCommandExecutor } from "../../src/host/host-command-executor.js";

const executor = new HostCommandExecutor();

test("HostCommandExecutor returns stdout, stderr, and exit code for a completed process", async () => {
  const result = await executor.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
  });

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(typeof result.durationMs, "number");
  assert.equal(result.error, undefined);
});

test("HostCommandExecutor reports a non-zero process as failed", async () => {
  const result = await executor.run({
    executable: process.execPath,
    args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "bad");
  assert.match(result.error ?? "", /Command failed|exit code|bad/i);
});

test("HostCommandExecutor reports a timeout separately from process failure", async () => {
  const result = await executor.run({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => undefined, 10_000)"],
    timeoutMs: 50,
  });

  assert.equal(result.status, "timed_out");
  assert.equal(result.exitCode, null);
  assert.notEqual(result.error, undefined);
});

test("HostCommandExecutor normalizes an unavailable executable as a failed result", async () => {
  const result = await executor.run({
    executable: "/definitely/not/a/real/scout-command",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.match(result.error ?? "", /ENOENT|not found|spawn/i);
});

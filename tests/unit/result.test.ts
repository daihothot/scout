import test from "node:test";
import assert from "node:assert/strict";
import { Result } from "../../src/core/result.js";

test("Result constructs typed success and error branches", () => {
  const success: Result<number, string> = Result.ok(42);
  assert.equal(success.ok, true);
  if (success.ok) {
    assert.equal(success.value, 42);
  }

  const failure: Result<number, string> = Result.err("worker_busy");
  assert.equal(failure.ok, false);
  if (!failure.ok) {
    assert.equal(failure.error, "worker_busy");
  }
});

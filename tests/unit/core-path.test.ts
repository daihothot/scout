import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join, resolve, sep } from "node:path";
import { isPathWithin } from "../../src/core/path.js";

test("isPathWithin distinguishes roots, descendants, siblings, and prefixes", () => {
  const root = resolve(process.cwd(), "path-fixture", "root");
  const cases = [
    [root, root, true],
    [root, join(root, "child", "file.txt"), true],
    [root, join(dirname(root), "sibling"), false],
    [root, `${root}-sibling`, false],
    [root, join(root, "..", "outside"), false],
    [root, resolve(root, ".."), false],
  ] as const;

  for (const [candidateRoot, target, expected] of cases) {
    assert.equal(isPathWithin(candidateRoot, target), expected, `${candidateRoot} -> ${target}`);
  }
});

test("isPathWithin supports strict-child checks and platform separators", () => {
  const root = resolve(process.cwd(), "path-fixture", "root");
  const child = join(root, "nested", `file${sep}name`);

  assert.equal(isPathWithin(root, root, { allowRoot: false }), false);
  assert.equal(isPathWithin(root, join(root, "nested"), { allowRoot: false }), true);
  assert.equal(isPathWithin(root, child), true);
});

test("isPathWithin normalizes relative inputs lexically", () => {
  assert.equal(isPathWithin("path-fixture/root", "path-fixture/root/child"), true);
  assert.equal(isPathWithin("path-fixture/root", "path-fixture/root/../outside"), false);
});

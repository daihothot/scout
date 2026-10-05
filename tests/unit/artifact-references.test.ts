import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeAgentArtifactReferences, resolveAgentArtifactReferences, parseArtifactReference, isArtifactTargetWithin } from "../../src/core/io/index.js";

test("agent-local artifact paths become stable Workflow identity references", () => {
  const input = [
    "- gate_ref: /repo/run/run-1/renamed-workflow/agents/validator/artifacts/research-pack-gate-0001.md",
    "- detail_ref: /repo/run/run-1/renamed-workflow/agents/validator/artifacts/details/issue.md",
  ].join("\n");
  const expected = [
    "- gate_ref: scout-artifact://workflow-001/validator/research-pack-gate-0001.md",
    "- detail_ref: scout-artifact://workflow-001/validator/details/issue.md",
  ].join("\n");

  const canonical = canonicalizeAgentArtifactReferences(input, {
    workflowId: "workflow-001", agentId: "validator",
    artifactRoot: "/repo/run/run-1/renamed-workflow/agents/validator/artifacts",
  });

  assert.equal(canonical, expected);
  assert.equal(canonicalizeAgentArtifactReferences(canonical, {
    workflowId: "workflow-001", agentId: "validator",
    artifactRoot: "/repo/run/run-1/renamed-workflow/agents/validator/artifacts",
  }), expected);
});

test("Artifact references address either an Agent root or an Artifact beneath the same owner", () => {
  const root = parseArtifactReference("scout-artifact://workflow-001/executor/");
  const pack = parseArtifactReference("scout-artifact://workflow-001/executor/bdd/26.9.0/execute-pack");
  assert.deepEqual(root, { workflowId: "workflow-001", agentId: "executor", internalSymbols: [] });
  assert.equal(isArtifactTargetWithin(root, pack), true);
  assert.equal(isArtifactTargetWithin(pack, root), false);
  assert.equal(isArtifactTargetWithin(root, { ...pack, workflowId: "workflow-002" }), false);
  assert.equal(isArtifactTargetWithin(pack, { ...pack, internalSymbols: ["bdd","26.9.0","execute-pack-other"] }), false);
  assert.equal(parseArtifactReference("scout-artifact://workflow-001/executor.2/").agentId, "executor.2");
  for (const reference of ["scout-artifact://workflow-001/executor", "scout-artifact://workflow-001/executor//", "scout-artifact://workflow-001/../", "scout-artifact://workflow-001/executor/../private", "scout-artifact://workflow-001/executor/pack/"]) {
    assert.throws(() => parseArtifactReference(reference), /Invalid scout-artifact/);
  }
});

test("artifact reference canonicalization leaves unrelated text unchanged", () => {
  assert.equal(canonicalizeAgentArtifactReferences("No artifact refs.", {
    workflowId: "workflow-001", agentId: "validator",
    artifactRoot: "/outside/artifacts",
  }), "No artifact refs.");
});

test("artifact references never remap another Workflow's path", () => {
  const path = "/repo/run/run-1/other-workflow/agents/validator/artifacts/gate.md";
  assert.equal(canonicalizeAgentArtifactReferences(path, {
    workflowId: "workflow-001", agentId: "validator",
    artifactRoot: "/repo/run/run-1/current-workflow/agents/validator/artifacts",
  }), path);
});

test("current Workflow references receive complete access paths without changing business content", () => {
  const ref = "scout-artifact://workflow-001/executor/history/001.json";
  const spacedRef = "scout-artifact://workflow-001/reviewer/review result.json";
  const businessContent = JSON.stringify({
    executorHistoryRef: ref,
    recordLocator: "JR/123",
    refs: ["SR/456", "firebase-remote-config-getter-default-fallback"],
    version: "26.7.0-rc.2",
  });
  const prompt = [
    `[history](${ref})`,
    businessContent,
    `- review_ref: \`${spacedRef}\``,
    "- execute_file_ref: scout-artifact://workflow-001/executor/bdd/26.7.0-rc.2/execute-file.json",
  ].join("\n");
  assert.deepEqual(resolveAgentArtifactReferences(prompt, {
    workflowId: "workflow-001",
    readRequests: [],
    artifacts: [
      { agentId: "executor", path: "/run/workflows/renamed execution/agents/executor/artifacts" },
      { agentId: "reviewer", path: "/run/workflows/renamed execution/agents/reviewer/artifacts" },
    ],
  }), [
    { ref, path: "/run/workflows/renamed execution/agents/executor/artifacts/history/001.json" },
    { ref: spacedRef, path: "/run/workflows/renamed execution/agents/reviewer/artifacts/review result.json" },
    { ref: "scout-artifact://workflow-001/executor/bdd/26.7.0-rc.2/execute-file.json", path: "/run/workflows/renamed execution/agents/executor/artifacts/bdd/26.7.0-rc.2/execute-file.json" },
  ]);
  assert.equal(prompt.split("\n")[1], businessContent);
});

test("artifact resolution follows the current physical directory while the persisted ref stays unchanged", () => {
  const ref = "scout-artifact://workflow-001/executor/result.json";
  for (const directory of ["workflow-001", "renamed evidence"]) {
    const path = `/run/workflows/${directory}/agents/executor/artifacts`;
    assert.deepEqual(resolveAgentArtifactReferences(ref, {
      workflowId: "workflow-001", artifacts: [{ agentId: "executor", path }], readRequests: [],
    }), [{ ref, path: `${path}/result.json` }]);
  }
});

test("artifact resolution does not expand historical, unknown or escaping references", () => {
  const prompt = [
    "scout-artifact://workflow-002/executor/result.json",
    "scout-artifact://workflow-001/unregistered/result.json",
    "scout-artifact://workflow-001/executor/../private.json",
    "scout-artifact://workflow-001/executor//outside/result.json",
    "scout-artifact://workflow-001/executor/.",
    "scout-artifact://workflow-001/executor/",
    "scout-artifact://workflow-001/executor/bad\u0000name.json",
  ].join("\n");
  assert.deepEqual(resolveAgentArtifactReferences(prompt, {
    workflowId: "workflow-001",
    readRequests: [],
    artifacts: [{ agentId: "executor", path: "/run/current/agents/executor/artifacts" }],
  }), []);
});

test("registered read roots resolve only the selected historical input after its directory is renamed", () => {
  const ref = "scout-artifact://workflow-009/old-executor/sample/26.9.0/execute-file.json";
  const rootRef = "scout-artifact://workflow-009/old-executor/sample/26.9.0";
  const prompt = [ref, ref, `${rootRef}/../../../private.json`, `${rootRef}-other/execute-file.json`,
    "scout-artifact://workflow-008/old-executor/sample/26.9.0/execute-file.json"].join("\n");
  for (const directory of ["imported", "renamed input"]) {
    const readPath = `/run/workflows/${directory}/agents/old-executor/artifacts/sample/26.9.0`;
    assert.deepEqual(resolveAgentArtifactReferences(prompt, {
      workflowId: "workflow-001", artifacts: [], readRequests: [{ artifact_ref: rootRef, read_path: readPath }],
    }), [{ ref, path: `${readPath}/execute-file.json` }]);
  }
});

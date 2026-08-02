import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeAgentArtifactReferences } from "../../src/agent/task/artifact-references.js";

test("agent-local artifact references become portable run references", () => {
  const input = [
    "- gate_ref: ${SCOUT_ARTIFACT_ROOT}/research-pack-gate-0001.md",
    "- detail_ref: ${SCOUT_ARTIFACT_ROOT}/details/issue.md",
  ].join("\n");
  const expected = [
    "- gate_ref: ${SCOUT_RUN_ROOT}/agents/validator/artifacts/research-pack-gate-0001.md",
    "- detail_ref: ${SCOUT_RUN_ROOT}/agents/validator/artifacts/details/issue.md",
  ].join("\n");

  const canonical = canonicalizeAgentArtifactReferences(input, {
    runRoot: "/repo/run/run-1",
    artifactRoot: "/repo/run/run-1/agents/validator/artifacts",
  });

  assert.equal(canonical, expected);
  assert.equal(canonicalizeAgentArtifactReferences(canonical, {
    runRoot: "/repo/run/run-1",
    artifactRoot: "/repo/run/run-1/agents/validator/artifacts",
  }), expected);
});

test("artifact reference canonicalization leaves unrelated text unchanged", () => {
  assert.equal(canonicalizeAgentArtifactReferences("No artifact refs.", {
    runRoot: "/repo/run/run-1",
    artifactRoot: "/outside/artifacts",
  }), "No artifact refs.");
});

test("artifact reference canonicalization rejects an artifact root outside the run", () => {
  assert.throws(
    () => canonicalizeAgentArtifactReferences("${SCOUT_ARTIFACT_ROOT}/gate.md", {
      runRoot: "/repo/run/run-1",
      artifactRoot: "/repo/run/other/agents/validator/artifacts",
    }),
    /must be a child of the run root/,
  );
});

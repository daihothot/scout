import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentSkillError,
  AgentSkillStore,
  type AgentSkillRuntimeScope,
  type AgentSkillSelectionDefinition,
  type AgentSkillSelectionResource,
} from "../../src/agent/skill/index.js";
import { ScoutAgentPhases } from "../../src/agent/thread/types.js";
import {
  ScoutSkillResourceRequirements,
  type ScoutSkillCatalogEntry,
  type ScoutSkillResourceRequirement,
} from "../../src/asset-store/contracts/skill.js";

const baseScope: AgentSkillRuntimeScope = {
  agentId: "researcher-1",
  taskId: "task-1",
  threadId: "thread-1",
  turnId: "turn-1",
  assetCommitId: "asset-current",
  phase: ScoutAgentPhases.Research,
};

test("AgentSkillStore discovery accepts only a direct child returned by the preceding step", () => {
  const store = new AgentSkillStore();
  const scope = runtimeScope();

  assert.deepEqual(store.startDiscovery({
    scope,
    familyPrefix: [],
    availableFamilies: ["validation", "operations"],
  }), {
    scope,
    familyPrefix: [],
    availableFamilies: ["validation", "operations"],
  });
  assert.deepEqual(store.updateDiscovery(scope, {
    familyPrefix: ["validation"],
    availableFamilies: ["workflow", "contract"],
  }).familyPrefix, ["validation"]);

  assertSkillError("family_navigation_mismatch", () => store.updateDiscovery(scope, {
    familyPrefix: ["validation", "workflow", "research"],
    availableFamilies: [],
  }));
  assertSkillError("family_navigation_mismatch", () => store.updateDiscovery(scope, {
    familyPrefix: ["validation", "unknown"],
    availableFamilies: [],
  }));

  assert.deepEqual(store.updateDiscovery(scope, {
    familyPrefix: ["validation", "workflow"],
    availableFamilies: ["research"],
  }).familyPrefix, ["validation", "workflow"]);
});

test("AgentSkillStore enforces direct-predecessor instructions separately from required readiness", () => {
  const store = new AgentSkillStore();
  const scope = runtimeScope();
  const selectionId = "selection-collector";
  store.issueSelection({
    scope,
    selectionId,
    family: ["validation", "collection"],
    selectedSkillIds: ["collector-implementation"],
    loadOrder: [
      { skillId: "base-contract", requiredSkillIds: [] },
      { skillId: "collector-tool", requiredSkillIds: [] },
      {
        skillId: "collector-implementation",
        requiredSkillIds: ["base-contract"],
      },
    ],
    resources: [
      skillResource("base-contract", "SKILL.md"),
      skillResource("base-contract", "references/contract.md"),
      skillResource("collector-tool", "SKILL.md"),
      skillResource("collector-implementation", "SKILL.md"),
      skillResource("collector-implementation", "references/collection.md"),
      skillResource(
        "collector-implementation",
        "references/optional-notes.md",
        ScoutSkillResourceRequirements.Optional,
      ),
    ],
  });

  assertSkillError("load_order_violation", () => store.recordResourceLoaded(
    scope,
    selectionId,
    "collector-implementation",
    "SKILL.md",
  ));

  // The dependency-free sibling is independent of the consumer's predecessor chain.
  store.recordResourceLoaded(scope, selectionId, "collector-tool", "SKILL.md");
  store.recordResourceLoaded(scope, selectionId, "base-contract", "SKILL.md");
  assertSkillError("skill_instructions_not_loaded", () => store.recordResourceLoaded(
    scope,
    selectionId,
    "collector-implementation",
    "references/collection.md",
  ));

  // A consumer waits for direct predecessor instructions, not every predecessor resource.
  store.recordResourceLoaded(scope, selectionId, "collector-implementation", "SKILL.md");
  const loading = store.recordResourceLoaded(
    scope,
    selectionId,
    "collector-implementation",
    "references/collection.md",
  );
  assert.equal(loading.selectionState, "loading");
  assert.deepEqual(loading.missingRequiredResources, [{
    skillId: "base-contract",
    resource: "references/contract.md",
  }]);
  assert.equal(
    loading.missingRequiredResources.some((resource) =>
      resource.resource === "references/optional-notes.md"
    ),
    false,
  );

  const ready = store.recordResourceLoaded(
    scope,
    selectionId,
    "base-contract",
    "references/contract.md",
  );
  assert.equal(ready.selectionState, "ready");
  assert.deepEqual(ready.missingRequiredResources, []);
  assert.doesNotThrow(() => store.assertReadyForTaskSubmission(scope));
});

test("AgentSkillStore accumulates same-scope selections and keeps earlier resources readable", () => {
  const store = new AgentSkillStore();
  const scope = runtimeScope();
  const first = singleSkillSelection(scope, "selection-base", "base-contract");
  store.issueSelection(first);
  store.recordResourceLoaded(scope, first.selectionId, "base-contract", "SKILL.md");

  store.startDiscovery({
    scope,
    familyPrefix: [],
    availableFamilies: ["validation"],
  });
  store.updateDiscovery(scope, {
    familyPrefix: ["validation"],
    availableFamilies: ["review"],
  });
  const second = singleSkillSelection(scope, "selection-review", "review-contract");
  store.issueSelection(second);

  const retained = store.recordResourceLoaded(
    scope,
    first.selectionId,
    "base-contract",
    "references/notes.md",
  );
  assert.equal(retained.selectionState, "ready");
  assert.deepEqual(store.getSelection(first.selectionId)?.loadedResources, [
    { skillId: "base-contract", resource: "SKILL.md" },
    { skillId: "base-contract", resource: "references/notes.md" },
  ]);
  assert.equal(store.getSelection(second.selectionId)?.selectionId, second.selectionId);
  assertSkillError("selection_incomplete", () => store.assertReadyForTaskSubmission(scope));

  store.recordResourceLoaded(scope, second.selectionId, "review-contract", "SKILL.md");
  assert.doesNotThrow(() => store.assertReadyForTaskSubmission(scope));
});

test("AgentSkillStore supersedes all-stale selections when the turn is reauthorized", () => {
  const store = new AgentSkillStore();
  const currentScope = runtimeScope();
  const staleScope = runtimeScope({ assetCommitId: "asset-stale" });
  const stale = singleSkillSelection(staleScope, "selection-stale", "stale-contract");
  store.issueSelection(stale);

  assert.doesNotThrow(() => store.startDiscovery({
    scope: currentScope,
    familyPrefix: [],
    availableFamilies: ["validation"],
  }));
  store.updateDiscovery(currentScope, {
    familyPrefix: ["validation"],
    availableFamilies: ["current"],
  });
  const current = singleSkillSelection(currentScope, "selection-current", "current-contract");
  assert.doesNotThrow(() => store.issueSelection(current));
  store.recordResourceLoaded(
    currentScope,
    current.selectionId,
    "current-contract",
    "SKILL.md",
  );

  assert.equal(store.getSelection(stale.selectionId)?.selectionId, stale.selectionId);
  assert.equal(store.getSelection(current.selectionId)?.selectionId, current.selectionId);
  assertSkillError("selection_scope_mismatch", () => store.assertResourceReadable(
    currentScope,
    stale.selectionId,
    "stale-contract",
    "SKILL.md",
  ));
  assert.doesNotThrow(() => store.assertReadyForTaskSubmission(currentScope));
});

test("AgentSkillStore direct reauthorization supersedes a ready stale selection", () => {
  const store = new AgentSkillStore();
  const currentScope = runtimeScope();
  const staleScope = runtimeScope({ phase: ScoutAgentPhases.Verify });
  const stale = singleSkillSelection(staleScope, "selection-old-phase", "old-contract");
  store.issueSelection(stale);
  store.recordResourceLoaded(staleScope, stale.selectionId, "old-contract", "SKILL.md");

  const current = singleSkillSelection(currentScope, "selection-current-phase", "current-contract");
  store.issueSelection(current);
  store.recordResourceLoaded(
    currentScope,
    current.selectionId,
    "current-contract",
    "SKILL.md",
  );
  assert.equal(store.selectionProjection(current.selectionId)?.selectionState, "ready");

  assertSkillError("selection_scope_mismatch", () => store.assertResourceReadable(
    currentScope,
    stale.selectionId,
    "old-contract",
    "SKILL.md",
  ));
  assert.doesNotThrow(() => store.assertReadyForTaskSubmission(currentScope));
});

test("AgentSkillStore correction source reauthorization ignores its superseded stale selection", () => {
  const store = new AgentSkillStore();
  const sourceScope = runtimeScope({ turnId: "turn-source" });
  const staleSourceScope = runtimeScope({
    turnId: "turn-source",
    taskId: "task-stale",
  });
  const stale = singleSkillSelection(
    staleSourceScope,
    "selection-source-stale",
    "stale-contract",
  );
  store.issueSelection(stale);
  store.recordResourceLoaded(
    staleSourceScope,
    stale.selectionId,
    "stale-contract",
    "SKILL.md",
  );
  const current = singleSkillSelection(
    sourceScope,
    "selection-source-current",
    "current-contract",
  );
  store.issueSelection(current);
  store.recordResourceLoaded(
    sourceScope,
    current.selectionId,
    "current-contract",
    "SKILL.md",
  );

  assert.doesNotThrow(() => store.assertReadyForTaskSubmission(
    runtimeScope({ turnId: "turn-correction" }),
    sourceScope.turnId,
  ));
});

test("AgentSkillStore accepts a correction turn backed by a ready source selection", () => {
  const store = new AgentSkillStore();
  const sourceScope = runtimeScope({ turnId: "turn-source" });
  const source = singleSkillSelection(
    sourceScope,
    "selection-source",
    "source-contract",
  );
  store.issueSelection(source);
  store.recordResourceLoaded(
    sourceScope,
    source.selectionId,
    "source-contract",
    "SKILL.md",
  );

  assert.doesNotThrow(() => store.assertReadyForTaskSubmission(
    runtimeScope({ turnId: "turn-correction" }),
    sourceScope.turnId,
  ));
});

test("AgentSkillStore records navigation reset as correction-turn discovery", () => {
  const store = new AgentSkillStore();
  const sourceScope = runtimeScope({ turnId: "turn-source" });
  const correctionScope = runtimeScope({ turnId: "turn-correction" });
  const source = singleSkillSelection(
    sourceScope,
    "selection-source",
    "source-contract",
  );
  store.issueSelection(source);
  store.recordResourceLoaded(
    sourceScope,
    source.selectionId,
    "source-contract",
    "SKILL.md",
  );

  const reset = store.findSkills({
    scope: correctionScope,
    catalog: [catalogSkill("available-contract", ["validation", "available"])],
    family: ["unknown"],
  });

  assert.equal(reset.status, "refine_required");
  assert.equal(reset.reason, "family_navigation_reset");
  assert.deepEqual(store.getDiscovery(correctionScope)?.familyPrefix, []);
  assertSkillError("discovery_incomplete", () => store.assertReadyForTaskSubmission(
    correctionScope,
    sourceScope.turnId,
  ));
});

test("AgentSkillStore unlocks a transitive dependency chain one direct edge at a time", () => {
  const store = new AgentSkillStore();
  const scope = runtimeScope();
  const selectionId = "selection-transitive";
  store.issueSelection({
    scope,
    selectionId,
    family: ["validation", "transitive"],
    selectedSkillIds: ["top-contract"],
    loadOrder: [
      { skillId: "base-contract", requiredSkillIds: [] },
      { skillId: "middle-contract", requiredSkillIds: ["base-contract"] },
      { skillId: "top-contract", requiredSkillIds: ["middle-contract"] },
    ],
    resources: [
      skillResource("base-contract", "SKILL.md"),
      skillResource("middle-contract", "SKILL.md"),
      skillResource("top-contract", "SKILL.md"),
    ],
  });

  assertSkillError("load_order_violation", () => store.recordResourceLoaded(
    scope,
    selectionId,
    "middle-contract",
    "SKILL.md",
  ));
  assertSkillError("load_order_violation", () => store.recordResourceLoaded(
    scope,
    selectionId,
    "top-contract",
    "SKILL.md",
  ));
  store.recordResourceLoaded(scope, selectionId, "base-contract", "SKILL.md");
  store.recordResourceLoaded(scope, selectionId, "middle-contract", "SKILL.md");
  const ready = store.recordResourceLoaded(scope, selectionId, "top-contract", "SKILL.md");

  assert.equal(ready.selectionState, "ready");
});

function runtimeScope(
  overrides: Partial<AgentSkillRuntimeScope> = {},
): AgentSkillRuntimeScope {
  return { ...baseScope, ...overrides };
}

function singleSkillSelection(
  scope: AgentSkillRuntimeScope,
  selectionId: string,
  skillId: string,
): AgentSkillSelectionDefinition {
  return {
    scope,
    selectionId,
    family: ["validation", "contract"],
    selectedSkillIds: [skillId],
    loadOrder: [{ skillId, requiredSkillIds: [] }],
    resources: [
      skillResource(skillId, "SKILL.md"),
      skillResource(
        skillId,
        "references/notes.md",
        ScoutSkillResourceRequirements.Optional,
      ),
    ],
  };
}

function skillResource(
  skillId: string,
  resource: string,
  requirement: ScoutSkillResourceRequirement = ScoutSkillResourceRequirements.Required,
): AgentSkillSelectionResource {
  return {
    skillId,
    resource,
    requirement,
    description: `${skillId} ${resource}`,
  };
}

function catalogSkill(name: string, family: string[]): ScoutSkillCatalogEntry {
  return {
    name,
    description: `${name} description`,
    summary: `${name} summary`,
    phase: [ScoutAgentPhases.Research],
    family,
    tags: ["contract"],
    requiredSkills: [],
    path: `.scout/skills/${name}/SKILL.md`,
    resources: [],
  };
}

function assertSkillError(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof AgentSkillError);
    assert.equal(error.code, code);
    return true;
  });
}

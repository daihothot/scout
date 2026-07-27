import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const checkerPath = join(repoRoot, "assets", "codex", "tools", "scout-research-artifact-check", "cli.cjs");

test("scout-research-artifact-check accepts a replayable ready Research pack", () => {
  const packRoot = createReadyResearchPack();

  const output = execFileSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.match(output, /research_pack_valid=true/);
  assert.match(output, /aggregate_count=5/);
  assert.match(output, /evidence_count=5/);
  assert.match(output, /pack_status=ready/);
  assert.match(output, /pack_completion_state=complete/);
  assert.match(output, /verification_point_count=1/);
});

test("scout-research-artifact-check derives a partial Pack state from aggregate states", () => {
  const packRoot = createReadyResearchPack();
  replaceInFile(join(packRoot, "bdd-evidence.md"), "status: ready", "status: draft");
  replaceInFile(join(packRoot, "bdd-evidence.md"), "completion_state: complete", "completion_state: partial");

  const output = execFileSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.match(output, /research_pack_valid=true/);
  assert.match(output, /pack_status=draft/);
  assert.match(output, /pack_completion_state=partial/);
});

test("scout-research-artifact-check derives a blocked Pack state from aggregate states", () => {
  const packRoot = createReadyResearchPack();
  replaceInFile(join(packRoot, "bdd-evidence.md"), "status: ready", "status: blocked");
  replaceInFile(join(packRoot, "bdd-evidence.md"), "completion_state: complete", "completion_state: blocked");
  replaceInFile(join(packRoot, "bdd-evidence.md"), "blocking_items: none", "blocking_items: BDD source unavailable");

  const output = execFileSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.match(output, /research_pack_valid=true/);
  assert.match(output, /pack_status=blocked/);
  assert.match(output, /pack_completion_state=blocked/);
});

test("scout-research-artifact-check rejects a versioned Research pack directory", () => {
  const packRoot = createReadyResearchPack();
  const versionedPackRoot = `${packRoot}-v2`;
  renameSync(packRoot, versionedPackRoot);

  const result = spawnSync(process.execPath, [checkerPath, "pack", versionedPackRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /VERSIONED_PACK_DIRECTORY_FORBIDDEN/);
});

test("scout-research-artifact-check rejects undeclared Research pack root files", () => {
  const packRoot = createReadyResearchPack();
  write(packRoot, "gate-followup.md", "# Gate Follow-up\n");

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNDECLARED_PACK_ENTRY/);
  assert.match(result.stderr, /gate-followup\.md/);
});

test("scout-research-artifact-check rejects the removed Pack index artifact", () => {
  const packRoot = createReadyResearchPack();
  write(packRoot, "index.md", "# Removed Research Index\n");

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNDECLARED_PACK_ENTRY/);
  assert.match(result.stderr, /index\.md/);
});

test("scout-research-artifact-check rejects contradictory state and non-replayable source evidence", () => {
  const packRoot = createReadyResearchPack();
  replaceInFile(join(packRoot, "bdd-evidence.md"), "completion_state: complete", "completion_state: partial");
  replaceInFile(join(packRoot, "evidence", "E-CODE-001.md"), "gitlink_commit: source-commit", "gitlink_commit: other-commit");
  replaceInFile(join(packRoot, "evidence", "E-CODE-001.md"), "source_file_worktree_state: clean", "source_file_worktree_state: modified");
  replaceInFile(join(packRoot, "evidence", "E-CAP-001.md"), "| 系统目标 | covered | 当前事实：系统目标 | CAPSRC-001 | none |", "| 系统目标 | unknown | 当前事实：系统目标 | CAPSRC-001 | none |");
  replaceInFile(join(packRoot, "verification-manual.md"), "- E-KB-001", "- E-KB-999");

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_STATE_PAIR/);
  assert.match(result.stderr, /GITLINK_COMMIT_MISMATCH/);
  assert.match(result.stderr, /SOURCE_FILE_NOT_CLEAN/);
  assert.match(result.stderr, /INVALID_COVERAGE_STATE/);
  assert.match(result.stderr, /UNREGISTERED_MANUAL_REF/);
});

test("scout-research-artifact-check checks one evidence artifact independently", () => {
  const packRoot = createReadyResearchPack();
  const evidencePath = join(packRoot, "evidence", "E-CODE-001.md");

  const output = execFileSync(process.execPath, [checkerPath, "evidence", evidencePath], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.match(output, /evidence_valid=true/);
  assert.match(output, /evidence_id=E-CODE-001/);
  assert.match(output, /evidence_status=source_verified/);
});

test("scout-research-artifact-check rejects removed E-CG evidence", () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "scout-codegraph-evidence-"));
  const evidencePath = join(evidenceRoot, "E-CG-001.md");
  writeFileSync(evidencePath, `---
evidence_id: E-CG-001
evidence_type: codegraph
status: ready
---
# E-CG-001
`, "utf8");

  const result = spawnSync(process.execPath, [checkerPath, "evidence", evidencePath], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_EVIDENCE_ID/);
});

test("scout-research-artifact-check rejects removed E-CG aggregate refs", () => {
  const packRoot = createReadyResearchPack();
  replaceInFile(join(packRoot, "verification-manual.md"), "- E-CODE-001", "- E-CG-001\n- E-CODE-001");

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /REMOVED_CODEGRAPH_EVIDENCE_REF/);
});

test("scout-research-artifact-check rejects removed E-API aggregate refs", () => {
  const packRoot = createReadyResearchPack();
  replaceInFile(join(packRoot, "verification-manual.md"), "- E-CODE-001", "- E-API-001\n- E-CODE-001");

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /REMOVED_API_EVIDENCE_REF/);
});

test("scout-research-artifact-check accepts multiple independent Capability evidence artifacts", () => {
  const packRoot = createReadyResearchPack();
  addSecondCapability(packRoot);

  const output = execFileSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.match(output, /research_pack_valid=true/);
  assert.match(output, /evidence_count=6/);
});

test("scout-research-artifact-check requires Availability and Platform to cover every Capability", () => {
  const packRoot = createReadyResearchPack();
  addSecondCapability(packRoot);
  replaceInFile(join(packRoot, "evidence", "E-AVAIL-001.md"), "- capability_refs: E-CAP-001, E-CAP-002", "- capability_refs: E-CAP-001");

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CAPABILITY_AGGREGATE_REF_MISSING/);
  assert.match(result.stderr, /E-AVAIL-001 does not include E-CAP-002/);
});

test("scout-research-artifact-check rejects an independent E-KB artifact", () => {
  const packRoot = createReadyResearchPack();
  write(join(packRoot, "evidence"), "E-KB-001.md", evidence("E-KB-001", "knowledge", "ready", ["Artifact State"]));

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /KNOWLEDGE_AGGREGATE_FILE_FORBIDDEN/);
});

test("scout-research-artifact-check rejects an independent E-BDD artifact", () => {
  const packRoot = createReadyResearchPack();
  write(join(packRoot, "evidence"), "E-BDD-001.md", evidence("E-BDD-001", "bdd", "ready", ["Artifact State"]));

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /BDD_AGGREGATE_FILE_FORBIDDEN/);
});

test("scout-research-artifact-check rejects non-singleton Availability and Platform ids", () => {
  const packRoot = createReadyResearchPack();
  write(join(packRoot, "evidence"), "E-AVAIL-002.md", availabilityEvidence("E-AVAIL-002"));
  write(join(packRoot, "evidence"), "E-PLATFORM-002.md", platformEvidence("E-PLATFORM-002"));

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /AVAILABILITY_SINGLETON_ID/);
  assert.match(result.stderr, /PLATFORM_SINGLETON_ID/);
});

test("scout-research-artifact-check requires all 11 dimensions in every Capability evidence", () => {
  const packRoot = createReadyResearchPack();
  replaceInFile(join(packRoot, "evidence", "E-CAP-001.md"), "| 系统目标 | covered | 当前事实：系统目标 | CAPSRC-001 | none |\n", "");

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /COVERAGE_DIMENSION_MISSING/);
});

test("scout-research-artifact-check rejects duplicate dimensions in Capability evidence", () => {
  const packRoot = createReadyResearchPack();
  const row = "| 系统目标 | covered | 当前事实：系统目标 | CAPSRC-001 | none |";
  replaceInFile(join(packRoot, "evidence", "E-CAP-001.md"), row, `${row}\n${row}`);

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DUPLICATE_COVERAGE_DIMENSION/);
});

test("scout-research-artifact-check checks one aggregate artifact independently", () => {
  const packRoot = createReadyResearchPack();
  const aggregatePath = join(packRoot, "knowledge-evidence.md");

  const output = execFileSync(process.execPath, [
    checkerPath,
    "aggregate",
    "knowledge-evidence",
    aggregatePath,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.match(output, /aggregate_valid=true/);
  assert.match(output, /aggregate_kind=knowledge-evidence/);
  assert.match(output, /aggregate_status=ready/);
});

test("scout-research-artifact-check rejects an unregistered persona evidence ref", () => {
  const packRoot = createReadyResearchPack();
  replaceInFile(join(packRoot, "verification-manual.md"), "persona_evidence_ref: E-PERSONA-001", "persona_evidence_ref: E-PERSONA-999");

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_PERSONA_EVIDENCE_REF|UNREGISTERED_EVIDENCE_REF/);
});

test("scout-research-artifact-check allows unknown Nice to Have persona fields", () => {
  const packRoot = createReadyResearchPack();
  for (const [field, value] of Object.entries({
    user_role: "free user",
    subscription_state: "free",
    value_segment: "irrelevant",
    demographic_flags: "irrelevant",
    locale_or_region: "irrelevant",
  })) {
    replaceInFile(join(packRoot, "evidence", "E-PERSONA-001.md"), `- ${field}: ${value}`, `- ${field}: unknown`);
  }

  const output = execFileSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.match(output, /research_pack_valid=true/);
});

test("scout-research-artifact-check accepts a generic human confirmation record", () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "scout-human-evidence-"));
  const evidencePath = join(evidenceRoot, "E-HUMAN-001.md");
  writeFileSync(evidencePath, humanConfirmationEvidence(), "utf8");

  const output = execFileSync(process.execPath, [checkerPath, "evidence", evidencePath], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.match(output, /evidence_valid=true/);
  assert.match(output, /evidence_id=E-HUMAN-001/);
});

test("scout-research-artifact-check rejects template instructions in ready artifacts", () => {
  const packRoot = createReadyResearchPack();
  replaceInFile(join(packRoot, "verification-manual.md"), "- product: GuruSdk", "- product: <填写经当前证据确认的产品名称>");

  const result = spawnSync(process.execPath, [checkerPath, "pack", packRoot], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEMPLATE_INSTRUCTION_REMAINS/);
});

test("Research artifact template headings remain English", () => {
  for (const relativeRoot of [
    "assets/codex/skills/domain-validation-research-pack/templates",
    "assets/codex/skills/tool-guru-knowledge/templates",
    "assets/codex/skills/tool-jarvis-codebase/templates",
    "assets/codex/skills/domain-validation-validator/templates",
    "assets/codex/skills/meta-scout-internal-skill-creator/templates",
  ]) {
    const templateRoot = join(repoRoot, relativeRoot);
    for (const file of readdirSync(templateRoot).filter((name) => name.endsWith(".md"))) {
      const headings = readFileSync(join(templateRoot, file), "utf8")
        .split("\n")
        .filter((line) => /^#{1,6}\s/.test(line));
      for (const heading of headings) {
        assert.doesNotMatch(heading, /\p{Script=Han}/u, `${relativeRoot}/${file}: ${heading}`);
      }
    }
  }
});

test("Artifact templates explain fillable fields in Chinese without fake examples", () => {
  for (const relativeRoot of [
    "assets/codex/skills/domain-validation-research-pack/templates",
    "assets/codex/skills/tool-guru-knowledge/templates",
    "assets/codex/skills/tool-jarvis-codebase/templates",
    "assets/codex/skills/domain-validation-validator/templates",
  ]) {
    const templateRoot = join(repoRoot, relativeRoot);
    for (const file of readdirSync(templateRoot).filter((name) => name.endsWith(".md") && name !== "template-index.md")) {
      const text = readFileSync(join(templateRoot, file), "utf8");
      const unexplainedFields = text.split("\n")
        .filter((line) => /^\s*-\s+[A-Za-z0-9_]+:\s*$/.test(line))
        .filter((line) => !/^\s*-\s+(?:commands|source_artifacts):\s*$/.test(line));
      assert.deepEqual(unexplainedFields, [], `${relativeRoot}/${file} contains an unexplained blank field`);
      assert.doesNotMatch(text, /^\s*-\s*$/m, `${relativeRoot}/${file} contains an unexplained blank list item`);
      assert.match(text, /<填写[^>]+>/, `${relativeRoot}/${file} must contain Chinese fill instructions`);
      assert.doesNotMatch(text, /示例[：:]/, `${relativeRoot}/${file} must not contain fake examples`);
      assert.doesNotMatch(text, /<!--\s*(?:Verify|Nice to Have)/, `${relativeRoot}/${file} must not use field classification comments`);
    }
  }
});

test("Verification Manual template defines one reusable verification point block", () => {
  const text = readFileSync(join(
    repoRoot,
    "assets/codex/skills/domain-validation-research-pack/templates/verification-manual.md",
  ), "utf8");
  assert.equal(text.match(/^### VP-\d+:/gm)?.length, 1);
  assert.match(text, /存在多个验证点时，复制完整区块/);
  assert.doesNotMatch(text, /^### VP-002:/m);
});

function createReadyResearchPack(): string {
  const packRoot = mkdtempSync(join(tmpdir(), "scout-research-pack-"));
  const evidenceRoot = join(packRoot, "evidence");
  mkdirSync(evidenceRoot, { recursive: true });

  write(packRoot, "bdd-evidence.md", aggregate("BDDEvidence", "E-BDD-001", `
## Evidence State
- status: ready
- completion_state: complete
- blocking_items: none
- human_confirmation_needed: none
- failed_commands: none
- retry_log: none
- limitations: none
## Target
- product: GuruSdk
## Behavior Identity
- behavior_id: test-behavior
## Claim
- 当前 Behavior 定义目标预期行为。
## Given
- a confirmed persona
## When
- the behavior is triggered
## Then
- the documented outcome is requested
## Expect
- behavior evidence is collected
## Candidate Resolution
- selected_reason: unique scenario id
## Evidence Registration
- evidence_id: E-BDD-001
- artifact_ref: bdd-evidence.md
- summary_ref: knowledge-evidence.md
- registry_ref: evidence-registry.md
## Supports
- VP-001
## Limitations
- none
`, "evidence_id: E-BDD-001\nevidence_type: bdd"));

  write(packRoot, "knowledge-evidence.md", aggregate("KnowledgeEvidencePack", "Knowledge Evidence", `
## Knowledge Evidence State
- status: ready
- completion_state: complete
- blocking_items: none
- human_confirmation_needed: none
- failed_commands: none
- retry_log: none
- limitations: none
## Knowledge Repository Provenance
- knowledge_repo: guru-knowledge
- knowledge_branch: main
- knowledge_commit: knowledge-commit
- knowledge_worktree_state: clean
- knowledge_root: Products/GuruSdk
## Knowledge Aggregate
- evidence_id: E-KB-001
- claim: 当前 BDD、Capability、Availability 和 Platform knowledge 形成闭环。
- supports: VP-001
- limitations: none
## BDD Evidence
### E-BDD-001
- artifact_ref: bdd-evidence.md
## Capability Evidence
### E-CAP-001
- artifact_ref: evidence/E-CAP-001.md
- capability: TestCapability
- relation_to_bdd: primary
- claim_supported: 当前 Capability 支撑目标 BDD。
- supports: VP-001
- limitations: none
## Specifications
| capability_evidence_ref | specification_sources | coverage_summary | limitations |
|---|---|---|---|
| E-CAP-001 | Domains/Test/Capabilities/TestCapability/Specifications.md | 11 个规格维度均已登记 | none |
## Availability Evidence
### E-AVAIL-001
- artifact_ref: evidence/E-AVAIL-001.md
- capability_refs: E-CAP-001
- claim_supported: 目标版本可用性已登记。
- supports: VP-001
- limitations: none
## Platform Evidence
### E-PLATFORM-001
- artifact_ref: evidence/E-PLATFORM-001.md
- capability_refs: E-CAP-001
- claim_supported: 目标平台事实已登记。
- supports: VP-001
- limitations: none
## Aggregation Notes
- all evidence is stored independently
`, "evidence_id: E-KB-001\nevidence_type: knowledge_aggregate"));

  write(packRoot, "code-evidence.md", aggregate("CodeEvidencePack", "Code Evidence", `
## Code Evidence State
- status: ready
- completion_state: complete
- blocking_items: none
- failed_commands: none
- retry_log: none
- limitations: none
## Root Repository Provenance
- root_repo: gurusdk-unity
- root_version: sdk/7.12.6
- root_branch: sdk/7.12.6
- root_commit: root-commit
- root_worktree_state: clean
- root_codebase_path: /runtime/gurusdk-unity
## Source Repository Provenance
| source_id | source_repo | source_version | source_branch | source_commit | source_worktree_state | source_codebase_path | gitlink_path | gitlink_commit | codegraph_status |
|---|---|---|---|---|---|---|---|---|---|
| SRC-001 | gurusdk-framework | sdk/7.12.6 | detached | source-commit | clean | /runtime/gurusdk-unity/gurusdk-framework | gurusdk-framework | source-commit | ready |
## Scope
- source_query_targets: test behavior
## Source Query Targets
| target_id | derived_from | query_target | expected_claim |
|---|---|---|---|
| SQT-001 | E-BDD-001 | TestService.Run | implementation exists |
## Implementation Claims
| claim_id | claim | source_id | code_evidence | limitations |
|---|---|---|---|---|
| IC-001 | TestService.Run handles the action | SRC-001 | E-CODE-001 | none |
## Source Code Evidence Refs
| evidence_id | artifact_ref | source | locator | claim_supported | supports | limitations |
|---|---|---|---|---|---|---|
| E-CODE-001 | evidence/E-CODE-001.md | gurusdk-framework | source-commit:Runtime/TestService.cs | current implementation | IC-001 | none |
## Aggregation Notes
- details remain in evidence artifacts
`));

  write(packRoot, "evidence-registry.md", aggregate("EvidenceRegistry", "Evidence Registry", `
## Registry State
- status: ready
- completion_state: complete
- blocking_items: none
- failed_commands: none
- retry_log: none
- limitations: none
${registrySection("BDD Evidence", "E-BDD-001", "Behaviors/test-behavior.md", "bdd-evidence.md")}
${registrySection("Knowledge Evidence", "E-KB-001", "Knowledge Aggregate", "knowledge-evidence.md")}
${registrySection("Capability Evidence", "E-CAP-001", "Domains/Test/Capabilities/TestCapability/index.md")}
${registrySection("Availability Evidence", "E-AVAIL-001", "Version Availability Matrix")}
${registrySection("Platform Evidence", "E-PLATFORM-001", "Platform Evidence Matrix")}
${registrySection("User Persona Evidence", "E-PERSONA-001", "evidence/E-PERSONA-001.md#Persona-Facts")}
## Human Confirmation Evidence
- none
${registrySection("Source Code Evidence", "E-CODE-001", "source-commit:Runtime/TestService.cs")}
`));

  write(packRoot, "verification-manual.md", aggregate("VerificationManual", "Verification Manual", `
## Manual State
- status: ready
- completion_state: complete
- human_confirmation_needed: none
- blocking_items: none
- failed_commands: none
- retry_log: none
- limitations: none
## Manual Identity
- manual_id: manual-001
## Product Scope
- product: GuruSdk
## Verification Points
### VP-001: Test behavior
- vp_id: VP-001
- function_point: documented test behavior
- persona_evidence_ref: E-PERSONA-001
- bdd_evidence_ref: E-BDD-001
- evidence_registry_ref: evidence-registry.md
#### Given
- the anonymous account state from E-BDD-001 and E-PERSONA-001
#### When
- the documented trigger occurs
#### Then
- collect the documented outcome signal
#### Supporting Evidence
- E-BDD-001
- E-KB-001
- E-CAP-001
- E-AVAIL-001
- E-PLATFORM-001
- E-PERSONA-001
- E-CODE-001
#### Signals To Collect
- runtime_log: related event payload
#### Human Confirmation Needed
- none
#### Notes
- no implementation claim is copied here
`));

  write(evidenceRoot, "E-CAP-001.md", capabilityEvidence("E-CAP-001", "TestCapability"));
  write(evidenceRoot, "E-AVAIL-001.md", availabilityEvidence("E-AVAIL-001"));
  write(evidenceRoot, "E-PLATFORM-001.md", platformEvidence("E-PLATFORM-001"));
  write(evidenceRoot, "E-PERSONA-001.md", userPersonaEvidence());
  write(evidenceRoot, "E-CODE-001.md", sourceCodeEvidence());
  return packRoot;
}

function aggregate(artifactType: string, title: string, body: string, extraFrontMatter = ""): string {
  const extra = extraFrontMatter ? `${extraFrontMatter.trim()}\n` : "";
  return `---\nartifact_type: ${artifactType}\nartifact_version: 1\n${extra}status: ready\ncompletion_state: complete\n---\n# ${title}\n${body.trim()}\n`;
}

function evidence(id: string, type: string, status: string, sections: string[]): string {
  return `---\nevidence_id: ${id}\nevidence_type: ${type}\nstatus: ${status}\n---\n# ${id}\n${sections.map((section) => `## ${section}\n${section === "Artifact State" ? `- status: ${status}` : "- concrete evidence content"}`).join("\n")}\n`;
}

function humanConfirmationEvidence(): string {
  return `---
evidence_id: E-HUMAN-001
evidence_type: human_confirmation
status: ready
---
# E-HUMAN-001
## Artifact State
- status: ready
## Confirmation Claim
- 用户确认当前应用版本为 7.12.6。
## Human Confirmation Source
- source_type: initial_user_input
- task_id: task-1
- request_step_id: none
- response_step_id: none
- source_locator: task:task-1:initial-user-input
## Confirmed Fact
- field: Product Scope.app_version
- value: 7.12.6
- applies_to: verification-manual.md
## Supports
- VP-001
## Limitations
- none
`;
}

function capabilityEvidence(id: string, capability: string): string {
  return `---
evidence_id: ${id}
evidence_type: capability
status: ready
---
# ${id}
## Artifact State
- status: ready
- blocking_items: none
- failed_commands: none
- retry_log: none
## Claim
- ${capability} 支撑当前 BDD 的职责与规格。
## Capability Identity
- product: GuruSdk
- domain: Test
- capability: ${capability}
- capability_id: ${capability.toLowerCase()}
- file: Domains/Test/Capabilities/${capability}/index.md
- status: active
- relation_to_bdd: primary
## Capability Scope
- responsibility: 处理目标场景。
- boundary: 仅覆盖当前测试能力。
- upstream: none
- downstream: none
## Source Refs
| source_id | document_type | file | locator | status |
|---|---|---|---|---|
| CAPSRC-001 | specification | Domains/Test/Capabilities/${capability}/Specifications.md | 系统目标 | active |
## Specification Coverage Matrix
| dimension | coverage_state | claim | source_refs | gap_or_rationale |
|---|---|---|---|---|
${coverageRows()}
## Supports
- VP-001
## Limitations
- none
`;
}

function availabilityEvidence(id: string): string {
  return `---
evidence_id: ${id}
evidence_type: availability
status: ready
---
# ${id}
## Artifact State
- status: ready
- blocking_items: none
- failed_commands: none
- retry_log: none
## Claim
- 相关 Capability 在目标版本中的可用性已登记。
## Availability Scope
- product: GuruSdk
- target_version: 7.12.6
- capability_refs: E-CAP-001
## Version Availability Matrix
| capability_ref | feature | source | locator | status | introduced_version | deprecated_version | removed_version | release_note | limitations |
|---|---|---|---|---|---|---|---|---|---|
| E-CAP-001 | TestFeature | Domains/Test/Availability.md | TestFeature | active | 7.0.0 | none | none | none | none |
## Supports
- VP-001
## Limitations
- none
`;
}

function platformEvidence(id: string): string {
  return `---
evidence_id: ${id}
evidence_type: platform_knowledge
status: ready
---
# ${id}
## Artifact State
- status: ready
- blocking_items: none
- failed_commands: none
- retry_log: none
## Claim
- 相关 Capability 的目标平台契约已登记。
## Platform Scope
- product: GuruSdk
- platform: ios
- capability_refs: E-CAP-001
## Platform Evidence Matrix
| capability_ref | source | locator | document_type | shared_contract | difference | status | limitations |
|---|---|---|---|---|---|---|---|
| E-CAP-001 | Domains/Test/Platforms/iOS.md | Shared Contract | platform | 保持测试行为 | none | active | none |
## Supports
- VP-001
## Limitations
- none
`;
}

function userPersonaEvidence(): string {
  return `---
evidence_id: E-PERSONA-001
evidence_type: user_persona
status: ready
---
# E-PERSONA-001
## Artifact State
- status: ready
## Persona Claim
- 本验证点使用匿名账号状态。
## Persona Identity
- persona_id: persona-001
## Persona Facts
- user_role: free user
- account_state: anonymous
- subscription_state: free
- value_segment: irrelevant
- demographic_flags: irrelevant
- locale_or_region: irrelevant
- platform: ios
- app_version: 7.12.6
## Source Evidence
- E-BDD-001
## Supports
- VP-001
## Limitations
- none
`;
}

function sourceCodeEvidence(): string {
  return `---
evidence_id: E-CODE-001
evidence_type: source_code
status: source_verified
---
# E-CODE-001
## Artifact State
- status: source_verified
## Claim
- current source contains TestService.Run
## Repository Provenance
${repositoryFields()}
## Replay Locator
- source_relative_file: Runtime/TestService.cs
- source_file_worktree_state: clean
- canonical_locator: source-commit:Runtime/TestService.cs
## Primary Symbol
- name: TestService.Run
- type: method
- start_line: 10
- end_line: 20
- signature: void Run()
## Key Lines
| line | reason |
|---:|---|
| 12 | invokes the action |
## Collection
- method: CodeGraph plus source read
- query_result_summary: CodeGraph located TestService.Run in Runtime/TestService.cs
## Supports
- IC-001
## Limitations
- none
`;
}

function repositoryFields(): string {
  return `- root_repo: gurusdk-unity
- root_version: sdk/7.12.6
- root_branch: sdk/7.12.6
- root_commit: root-commit
- root_worktree_state: clean
- root_codebase_path: /runtime/gurusdk-unity
- source_repo: gurusdk-framework
- source_version: sdk/7.12.6
- source_branch: detached
- source_commit: source-commit
- source_worktree_state: clean
- source_codebase_path: /runtime/gurusdk-unity/gurusdk-framework
- gitlink_path: gurusdk-framework
- gitlink_commit: source-commit
- gitlink_matches_source_commit: true
- codegraph_status: ready`;
}

function coverageRows(): string {
  return [
    "系统目标", "系统边界", "用户角色", "核心能力", "关键流程", "领域对象",
    "状态变化", "业务规则", "数据与接口", "非功能要求", "验收场景",
  ].map((dimension) => `| ${dimension} | covered | 当前事实：${dimension} | CAPSRC-001 | none |`).join("\n");
}

function registrySection(title: string, id: string, locator: string, artifactRef = `evidence/${id}.md`): string {
  return `## ${title}
### ${id}
- artifact_ref: ${artifactRef}
- source: current research source
- locator: ${locator}
- claim_supported: traceable claim
- supports: VP-001
- limitations: none`;
}

function addSecondCapability(packRoot: string): void {
  write(join(packRoot, "evidence"), "E-CAP-002.md", capabilityEvidence("E-CAP-002", "SupportingCapability"));
  replaceInFile(join(packRoot, "knowledge-evidence.md"), "## Specifications", `### E-CAP-002
- artifact_ref: evidence/E-CAP-002.md
- capability: SupportingCapability
- relation_to_bdd: supporting
- claim_supported: SupportingCapability 提供上游支撑。
- supports: VP-001
- limitations: none
## Specifications`);
  replaceInFile(join(packRoot, "knowledge-evidence.md"), "| E-CAP-001 | Domains/Test/Capabilities/TestCapability/Specifications.md | 11 个规格维度均已登记 | none |", "| E-CAP-001 | Domains/Test/Capabilities/TestCapability/Specifications.md | 11 个规格维度均已登记 | none |\n| E-CAP-002 | Domains/Test/Capabilities/SupportingCapability/Specifications.md | 11 个规格维度均已登记 | none |");
  for (const file of ["E-AVAIL-001.md", "E-PLATFORM-001.md"]) {
    replaceInFile(join(packRoot, "evidence", file), "- capability_refs: E-CAP-001", "- capability_refs: E-CAP-001, E-CAP-002");
  }
  replaceInFile(join(packRoot, "evidence-registry.md"), "## Availability Evidence", `${registrySection("Capability Evidence", "E-CAP-002", "Domains/Test/Capabilities/SupportingCapability/index.md")}
## Availability Evidence`);
  replaceInFile(join(packRoot, "verification-manual.md"), "- E-CAP-001", "- E-CAP-001\n- E-CAP-002");
}

function write(root: string, relativePath: string, text: string): void {
  writeFileSync(join(root, relativePath), text, "utf8");
}

function replaceInFile(path: string, from: string, to: string): void {
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes(from), `Expected fixture text in ${path}: ${from}`);
  writeFileSync(path, text.replaceAll(from, to), "utf8");
}

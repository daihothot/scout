import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  assert.match(output, /evidence_count=4/);
  assert.match(output, /verification_point_count=1/);
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

test("scout-research-artifact-check rejects contradictory state and non-replayable source evidence", () => {
  const packRoot = createReadyResearchPack();
  replaceInFile(join(packRoot, "index.md"), "completion_state: complete", "completion_state: partial");
  replaceInFile(join(packRoot, "evidence", "E-CODE-001.md"), "gitlink_commit: source-commit", "gitlink_commit: other-commit");
  replaceInFile(join(packRoot, "evidence", "E-CODE-001.md"), "source_file_worktree_state: clean", "source_file_worktree_state: modified");
  replaceInFile(join(packRoot, "knowledge-evidence.md"), "| 系统目标 | covered | E-KB-001 | none |", "| 系统目标 | unknown | E-KB-001 | none |");
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

function createReadyResearchPack(): string {
  const packRoot = mkdtempSync(join(tmpdir(), "scout-research-pack-"));
  const evidenceRoot = join(packRoot, "evidence");
  mkdirSync(evidenceRoot, { recursive: true });

  write(packRoot, "index.md", aggregate("ResearchIndex", "Research Index", `
## Research State
- status: ready
- completion_state: complete
- current_phase: Phase 6
- blocking_items: none
- human_confirmation_needed: none
- failed_commands: none
- retry_log: none
- limitations: none
## Scope
- product: GuruSdk
## Artifact Refs
| artifact | path | status | notes |
|---|---|---|---|
| Verification Manual | verification-manual.md | ready | none |
## Phase Resume
| phase | status | inputs | outputs | next_entry |
|---|---|---|---|---|
| Phase 6 | complete | evidence-registry.md | verification-manual.md | none |
## Evidence Summary
- BDD evidence: E-BDD-001
## Knowledge Repository Provenance
- knowledge_repo: guru-knowledge
- knowledge_branch: main
- knowledge_commit: knowledge-commit
- knowledge_worktree_state: clean
- knowledge_root: Products/GuruSdk
- knowledge_refs: Behaviors/test-behavior.md
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
## Collection Provenance
- commands: git; codegraph
- codegraph_project_root: /runtime/gurusdk-unity
- codegraph_status: ready
`));

  write(packRoot, "bdd-fact.md", aggregate("BDDFact", "BDD Fact", `
## Fact State
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
## Given
- a confirmed persona
## When
- the behavior is triggered
## Then
- the documented outcome is requested
## Expect
- behavior evidence is collected
## User Persona
- user_role: free user
## Candidate Resolution
- selected_reason: unique scenario id
## Derived Evidence
- derived_evidence_id: E-BDD-001
- artifact_ref: evidence/E-BDD-001.md
## Limitations
- none
`));

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
## BDD Evidence
### E-BDD-001
- artifact_ref: evidence/E-BDD-001.md
## Canonical Knowledge Evidence
### E-KB-001
- artifact_ref: evidence/E-KB-001.md
## Availability Evidence
- none
## API Evidence
- none
## Platform Evidence
- none
## Specification Coverage Matrix
| dimension | coverage_state | evidence_refs | gap_or_rationale |
|---|---|---|---|
${coverageRows()}
## 聚合说明
- all evidence is stored independently
`));

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
| claim_id | claim | source_id | supported_by | code_evidence | limitations |
|---|---|---|---|---|---|
| IC-001 | TestService.Run handles the action | SRC-001 | E-CG-001 | E-CODE-001 | none |
## CodeGraph Evidence Refs
| evidence_id | artifact_ref | source | locator | claim_supported | supports | limitations |
|---|---|---|---|---|---|---|
| E-CG-001 | evidence/E-CG-001.md | gurusdk-framework | source-commit:Runtime/TestService.cs | symbol location | IC-001 | none |
## Source Code Evidence Refs
| evidence_id | artifact_ref | source | locator | claim_supported | supports | limitations |
|---|---|---|---|---|---|---|
| E-CODE-001 | evidence/E-CODE-001.md | gurusdk-framework | source-commit:Runtime/TestService.cs | current implementation | IC-001 | none |
## 聚合说明
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
${registrySection("BDD Evidence", "E-BDD-001", "Behaviors/test-behavior.md")}
${registrySection("Knowledge Evidence", "E-KB-001", "Domains/Test/Capability.md")}
## Availability Evidence
- none
## API Evidence
- none
## Platform Evidence
- none
${registrySection("CodeGraph Evidence", "E-CG-001", "source-commit:Runtime/TestService.cs")}
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
## User Persona To Confirm
- persona_id: persona-001
- account_state: anonymous
- subscription_state: free
- value_segment: irrelevant
- demographic_flags: irrelevant
- locale_or_region: irrelevant
- platform: ios
- app_version: 7.12.6
- confirmation_needed: none
## Verification Points
### VP-001: Test behavior
- vp_id: VP-001
- function_point: documented test behavior
- user_role: free user
- persona_ref: persona-001
- bdd_evidence_ref: E-BDD-001
- evidence_registry_ref: evidence-registry.md
#### Given
- the confirmed free user state from E-BDD-001
#### When
- the documented trigger occurs
#### Then
- collect the documented outcome signal
#### Supporting Evidence
- E-BDD-001
- E-KB-001
- E-CG-001
- E-CODE-001
#### Signals To Collect
- runtime_log: related event payload
#### 需人工确认项
- none
#### Notes
- no implementation claim is copied here
`));

  write(evidenceRoot, "E-BDD-001.md", evidence("E-BDD-001", "bdd", "ready", [
    "Artifact State", "Claim", "Behavior Ref", "Given", "When", "Then", "Expect", "Locator", "Supports", "Limitations",
  ]));
  write(evidenceRoot, "E-KB-001.md", evidence("E-KB-001", "knowledge", "ready", [
    "Artifact State", "Claim", "Knowledge Ref", "Locator", "Summary", "Supports", "Limitations",
  ]));
  write(evidenceRoot, "E-CG-001.md", codeGraphEvidence());
  write(evidenceRoot, "E-CODE-001.md", sourceCodeEvidence());
  return packRoot;
}

function aggregate(artifactType: string, title: string, body: string): string {
  return `---\nartifact_type: ${artifactType}\nartifact_version: 1\nstatus: ready\ncompletion_state: complete\n---\n# ${title}\n${body.trim()}\n`;
}

function evidence(id: string, type: string, status: string, sections: string[]): string {
  return `---\nevidence_id: ${id}\nevidence_type: ${type}\nstatus: ${status}\n---\n# ${id}\n${sections.map((section) => `## ${section}\n${section === "Artifact State" ? `- status: ${status}` : "- concrete evidence content"}`).join("\n")}\n`;
}

function codeGraphEvidence(): string {
  return `---
evidence_id: E-CG-001
evidence_type: codegraph
status: ready
---
# E-CG-001
## Artifact State
- status: ready
## Claim
- symbol location
## Repository Provenance
${repositoryFields()}
## Query
- command: codegraph query TestService
## Result
- matched_symbol: TestService.Run
- matched_file: gurusdk-framework/Runtime/TestService.cs
- source_relative_file: Runtime/TestService.cs
- relation: method
- confidence: high
## Located Symbols
| symbol | type | file | locator | note |
|---|---|---|---|---|
| TestService.Run | method | Runtime/TestService.cs | lines 10-20 | primary |
## Supports
- IC-001
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
  ].map((dimension) => `| ${dimension} | covered | E-KB-001 | none |`).join("\n");
}

function registrySection(title: string, id: string, locator: string): string {
  return `## ${title}
### ${id}
- artifact_ref: evidence/${id}.md
- source: current research source
- locator: ${locator}
- claim_supported: traceable claim
- supports: VP-001
- limitations: none`;
}

function write(root: string, relativePath: string, text: string): void {
  writeFileSync(join(root, relativePath), text, "utf8");
}

function replaceInFile(path: string, from: string, to: string): void {
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes(from), `Expected fixture text in ${path}: ${from}`);
  writeFileSync(path, text.replaceAll(from, to), "utf8");
}

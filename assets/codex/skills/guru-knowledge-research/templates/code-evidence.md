---
artifact_type: CodeEvidencePack
artifact_version: 1
status: draft
completion_state: partial
---

# Code Evidence

## Code Evidence State

- status:
- completion_state:
- blocking_items:
- failed_commands:
- retry_log:
- limitations:

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## Root Repository Provenance

- root_repo:
- root_version:
- root_branch:
- root_commit:
- root_worktree_state:
- root_codebase_path:

## Source Repository Provenance

| source_id | source_repo | source_version | source_branch | source_commit | source_worktree_state | source_codebase_path | gitlink_path | gitlink_commit | codegraph_status |
|---|---|---|---|---|---|---|---|---|---|
| SRC-001 |  |  |  |  |  |  |  |  |  |

## Scope

- source_query_targets:

## Source Query Targets

| target_id | derived_from | query_target | expected_claim |
|---|---|---|---|
| SQT-001 |  |  |  |

## Implementation Claims

| claim_id | claim | source_id | supported_by | code_evidence | limitations |
|---|---|---|---|---|---|
| IC-001 |  | SRC-001 | E-CG-001 | E-CODE-001 |  |

## CodeGraph Evidence Refs

| evidence_id | artifact_ref | source | locator | claim_supported | supports | limitations |
|---|---|---|---|---|---|---|
| E-CG-001 |  |  |  |  |  |  |

## Source Code Evidence Refs

| evidence_id | artifact_ref | source | locator | claim_supported | supports | limitations |
|---|---|---|---|---|---|---|
| E-CODE-001 |  |  |  |  |  |  |

## 聚合说明

- `E-CG-*` 和 `E-CODE-*` artifact refs 由 `jarvis-codebase` 产出。
- 本文件只聚合 refs 和 claim mapping；它不能替代 source evidence artifacts。
- Implementation claims 只登记在本文件中；`knowledge-evidence.md` 记录 intent / spec / behavior evidence，`verification-manual.md` 只引用 evidence ids。

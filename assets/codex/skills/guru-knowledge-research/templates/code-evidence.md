---
artifact_type: CodeEvidencePack
artifact_version: 1
status: draft
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

- status: draft | ready | blocked
- completion_state: complete | partial | blocked

## Scope

- repo:
- version:
- branch:
- commit:
- codebase_path:
- source_query_targets:

## Source Query Targets

| target_id | derived_from | query_target | expected_claim |
|---|---|---|---|
| SQT-001 |  |  |  |

## Implementation Claims

| claim_id | claim | supported_by | code_evidence | limitations |
|---|---|---|---|---|
| IC-001 |  | E-CG-001 | E-CODE-001 |  |

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

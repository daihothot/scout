---
artifact_type: KnowledgeEvidencePack
artifact_version: 1
status: draft
completion_state: partial
---

# Knowledge Evidence

## Knowledge Evidence State

- status:
- completion_state:
- blocking_items:
- human_confirmation_needed:
- failed_commands:
- retry_log:
- limitations:

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## Knowledge Repository Provenance

- knowledge_repo:
- knowledge_branch:
- knowledge_commit:
- knowledge_worktree_state:
- knowledge_root:

## BDD Evidence

### E-BDD-001

- template: templates/bdd-evidence.md
- artifact_ref:
- source:
- locator:
- claim_supported:
- supports:
- limitations:

## Canonical Knowledge Evidence

### E-KB-001

- template: templates/knowledge-evidence-block.md
- artifact_ref:
- source:
- locator:
- claim_supported:
- supports:
- limitations:

## Availability Evidence

### E-AVAIL-001

- template: templates/availability-evidence.md
- artifact_ref:
- source:
- locator:
- claim_supported:
- supports:
- limitations:

## API Evidence

### E-API-001

- template: templates/api-evidence.md
- artifact_ref:
- source:
- locator:
- claim_supported:
- supports:
- limitations:

## Platform Evidence

### E-PLATFORM-001

- template: templates/platform-evidence.md
- artifact_ref:
- source:
- locator:
- claim_supported:
- supports:
- limitations:

## Specification Coverage Matrix

| dimension | coverage_state | evidence_refs | gap_or_rationale |
|---|---|---|---|
| 系统目标 |  |  |  |
| 系统边界 |  |  |  |
| 用户角色 |  |  |  |
| 核心能力 |  |  |  |
| 关键流程 |  |  |  |
| 领域对象 |  |  |  |
| 状态变化 |  |  |  |
| 业务规则 |  |  |  |
| 数据与接口 |  |  |  |
| 非功能要求 |  |  |  |
| 验收场景 |  |  |  |

覆盖状态枚举：

- `covered`
- `not_applicable`
- `not_found`
- `needs_confirmation`

## 聚合说明

- 本文件只做摘要聚合。
- 不在本文件中嵌入完整 evidence blocks。
- 每个 evidence id 必须引用独立 evidence artifact 的 `artifact_ref`。
- 完整 source text 必须保留在原始 Guru knowledge 文件中。
- Implementation claims 属于 `code-evidence.md`，不属于本文件。
- 本文件列出的每个 evidence id 都必须同时出现在 `evidence-registry.md`。

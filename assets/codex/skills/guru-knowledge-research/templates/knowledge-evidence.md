---
artifact_type: KnowledgeEvidencePack
artifact_version: 1
status: draft
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

- status: draft | ready | blocked
- completion_state: complete | partial | blocked

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

## 聚合说明

- 本文件只做摘要聚合。
- 不在本文件中嵌入完整 evidence blocks。
- 每个 evidence id 必须引用独立 evidence artifact 的 `artifact_ref`。
- 完整 source text 必须保留在原始 Guru knowledge 文件中。
- Implementation claims 属于 `code-evidence.md`，不属于本文件。
- 本文件列出的每个 evidence id 都必须同时出现在 `evidence-registry.md`。

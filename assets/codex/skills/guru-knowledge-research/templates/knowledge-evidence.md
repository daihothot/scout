---
artifact_type: KnowledgeEvidencePack
artifact_version: 1
evidence_id: E-KB-001
evidence_type: knowledge_aggregate
status: draft
completion_state: partial
---

# Knowledge Evidence

## Knowledge Evidence State

- status: <填写 draft、ready 或 blocked，并与 frontmatter 保持一致>
- completion_state: <填写 partial、complete 或 blocked，并与 status 组成合法状态>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- human_confirmation_needed: <无需人工求证时填写 none，否则列出待确认问题>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>
- limitations: <没有已知限制时填写 none，否则说明 knowledge evidence 的适用边界>

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## Knowledge Repository Provenance

- knowledge_repo: <填写当前 knowledge 仓库名称>
- knowledge_branch: <填写收集证据时的 branch>
- knowledge_commit: <填写收集证据时的完整 commit>
- knowledge_worktree_state: <填写 clean 或具体修改状态>
- knowledge_root: <填写本次 run 使用的 knowledge 根路径>

## Knowledge Aggregate

- evidence_id: E-KB-001
- claim: <填写 BDD、Capabilities、Specifications、Availability 和 Platform 共同支持的 knowledge aggregate claim>
- supports: <填写该集合证据支持的 VP-* 引用>
- limitations: <填写集合证据的适用边界；Nice to Have，可不填写>

## BDD Evidence

### E-BDD-001

- template: templates/bdd-evidence.md
- artifact_ref: bdd-evidence.md
- source: <填写 Behavior 来源文件>
- locator: <填写 Scenario 标题、段落或表格定位>
- claim_supported: <填写该 Behavior 能够支持的预期行为 claim>
- supports: <填写该 evidence 支持的 VP-* 引用>
- limitations: <填写 BDD evidence 的额外限制；Nice to Have，可不填写>

## Capability Evidence

### E-CAP-001

- template: templates/capability-evidence.md
- artifact_ref: <填写 E-CAP-* 独立 evidence artifact ref>
- capability: <填写 Capability 名称>
- relation_to_bdd: <填写 primary、upstream、downstream 或 supporting>
- claim_supported: <填写该 Capability evidence 能够支持的 claim>
- supports: <填写该 Capability evidence 支持的 VP-* 引用>
- limitations: <填写 Capability evidence 的额外限制；Nice to Have，可不填写>

## Specifications

| capability_evidence_ref | specification_sources | coverage_summary | limitations |
|---|---|---|---|
| E-CAP-001 | <填写该 Capability 使用的 Specifications 来源> | <填写 11 个固定规格维度的覆盖摘要> | <填写规格覆盖限制；Nice to Have，可不填写> |

## Availability Evidence

### E-AVAIL-001

- template: templates/availability-evidence.md
- artifact_ref: evidence/E-AVAIL-001.md
- capability_refs: <填写该 Availability 聚合覆盖的 E-CAP-* 引用>
- claim_supported: <填写目标版本下相关 Capabilities 的可用性 claim>
- supports: <填写该 Availability evidence 支持的 VP-* 引用>
- limitations: <填写 Availability evidence 的额外限制；Nice to Have，可不填写>

## Platform Evidence

### E-PLATFORM-001

- template: templates/platform-evidence.md
- artifact_ref: evidence/E-PLATFORM-001.md
- capability_refs: <填写该 Platform 聚合覆盖的 E-CAP-* 引用>
- claim_supported: <填写目标平台下相关 Capabilities 的共享契约或差异 claim>
- supports: <填写该 Platform evidence 支持的 VP-* 引用>
- limitations: <填写 Platform evidence 的额外限制；Nice to Have，可不填写>

## Aggregation Notes

- 本文件是唯一 `E-KB-001` Knowledge 聚合证据。
- BDD、Capability、Availability 和 Platform evidence 只记录 refs，不嵌入完整 evidence blocks。
- API Index 或 API 文档只作为 `E-CAP-*` 的 `CAPSRC-*` 和“数据与接口”规格来源，不分配独立 evidence id。
- 每个 Pack 只允许一份 `E-AVAIL-001` 和一份 `E-PLATFORM-001` 独立 artifact。
- 每个相关 Capability 必须引用一份独立 `E-CAP-*` artifact。
- 完整 source text 必须保留在原始 Guru knowledge 文件中。
- Implementation claims 属于 `code-evidence.md`，不属于本文件。
- 本文件列出的每个 evidence id 都必须同时出现在 `evidence-registry.md`。

---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 的唯一 BDD evidence 模板。
artifact_type: RBTBDDEvidence
artifact_version: 1
evidence_id: E-BDD-001
status: draft
completion_state: partial
---

# BDD Evidence

## Evidence State

- evidence_id: E-BDD-001
- status: <填写 draft、ready 或 blocked>
- completion_state: <填写 partial、complete 或 blocked>
- blocking_items: <无阻塞项时填写 none；否则说明阻塞事实>
- limitations: <无已知限制时填写 none；否则说明适用边界>

## BDD Identity

- bdd_id: <填写唯一 BDD ID 原始值>
- scenario_id: <填写 BDD 声明的 scenario ID 原始值>
- case_id: <填写当前执行 case ID 原始值>
- source_ref: <填写 Knowledge 根目录内的稳定 ref 原始值>
- source_locator: <填写标题、段落、表格行或其它 source locator 原始值>
- source_status: <填写来源声明 status 原始值>

## Claim

- <填写本次执行要覆盖的 BDD claim；技术值保持原样>

## Given

- <逐项填写 BDD 明确要求的前置状态；技术值保持原样>

## When

- <逐项填写 BDD 明确要求的触发动作；command 和技术值保持原样>

## Then

- <逐项填写 BDD 明确要求的预期行为；技术值保持原样>

## Boundaries

- <填写 BDD 明确排除的行为、后置能力和相邻场景；技术值保持原样>

## Supports

- <填写该 BDD evidence 支持的 JR-* 与 SR-* IDs>

Frontmatter 与 `Evidence State` 中的 `status`、`completion_state` 必须完全一致。

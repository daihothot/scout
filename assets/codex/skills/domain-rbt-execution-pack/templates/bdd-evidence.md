---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 的唯一 BDD evidence 模板。
artifact_type: RBTBDDEvidence
artifact_version: 1
evidence_id: E-BDD-001
---

# BDD Evidence

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

---
scout:
  resource:
    requirement: required
    description: 用有序表格声明 Journal 观察点、关键 identity 和对应 Signal 预期。
artifact_type: RBTJournalExpected
artifact_version: 4
---

# Journal Expected

## Query Scope

- campaignId: <本次 campaignId 原始值>
- scenarioId: <本次 scenarioId 原始值>

## Expected Journal Records

每行一个稳定的 `JR-*` 观察点。重点字段用于直观定位和对照，完整的业务预期由 `signal_refs` 指向的 SR 声明。

| order | jr_id | kind | id | variantId | sourceId | captureId | signal_refs |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | JR-001 | <wire kind> | <Node ID 或 none> | <Variant ID 或 none> | <Source ID 或 none> | <Capture ID 或 none> | SR-001 |
| 2 | JR-002 | <wire kind> | <Node ID 或 none> | <Variant ID 或 none> | <Source ID 或 none> | <Capture ID 或 none> | SR-002 |

## Rules

- `order` 是执行前声明的相对先后，不是预测的 Runtime `sequence`。仅为 BDD 或业务源码支持的先后关系填写递增数字；不要求顺序的行填 `none`，行的展示位置本身不增加时间断言。
- JR 的关键 identity 是对应 SR 的可读摘录，必须与 SR Fields 一致。用于断言的值不能被偷偷提升成查询过滤条件。
- `none` 表示该列不约束；真实空字符串必须写 `""`。不预造 Runtime 分配的 correlationId、traceId、sequence 或 timestamp。
- `signal_refs` 只向下引用已声明的 present SR；允许一行关联同一 record 的多项完整预期，不强制 JR/SR 一对一。不同 record 的预期不能合并成同一 JR。
- absent SR 在 Signal 中独立比较，不伪造不存在的 record 或顺序位置；没有需要展示的 Journal 观察点时本表填 `none`。
- Reviewer 用声明的定位条件确认实际 record，并分别核对关联 SR。只有关联关系能指向同一条实际 record 时，才用实际 `sequence` 比较有 order 的行；多候选无法消歧时保留 unresolved。
- Journal 顺序只说明写入先后，不单独证明业务因果、持续状态或持续时长。

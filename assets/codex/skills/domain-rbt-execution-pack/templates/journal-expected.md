---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 的预期流程和 Campaign Journal 对照模板。
artifact_type: RBTJournalExpected
artifact_version: 1
status: draft
completion_state: partial
---

# Journal Expected

## Expected State

- status: <填写 draft、ready 或 blocked>
- completion_state: <填写 partial、complete 或 blocked>
- bdd_ref: E-BDD-001
- blocking_items: <无阻塞项时填写 none；否则说明阻塞事实>
- limitations: <无已知限制时填写 none；否则说明适用边界>

## Expected Journal Records

每个可独立定位的 Journal expectation 使用唯一 `JR-*`，并按预期相对顺序写入一行：

| sequence | jr_id | expected_presence | kind | campaignId | scenarioId | correlationId | sourceId | captureId | id | variantId | result | signal_refs | bdd_refs |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | JR-001 | <填写 present 或 absent> | <填写 RuntimeEvidence kind 原始值> | <填写预期 campaignId 原始值> | <填写预期 scenarioId 原始值> | <填写预期 correlationId 原始值；不参与定位时填写 none> | <填写预期 sourceId 原始值；不参与定位时填写 none> | <填写预期 captureId 原始值；不参与定位时填写 none> | <填写预期 id 原始值；不参与定位时填写 none> | <填写预期 variantId 原始值；不参与定位时填写 none> | <填写预期 result 原始值；不参与判断时填写 none> | <填写关联的 SR-* IDs；没有时填写 none> | <填写 E-BDD-* IDs> |

## Journal Boundary

- 本文件只保存预期流程和对照条件，不保存实际 Campaign Journal、命令回包或 Runtime trace。
- `sequence` 从 `1` 开始，只表示这些 `JR-*` 的预期相对顺序；它不替代、预测或改写 RuntimeEvidence 的实际 `sequence`。
- 表中 RuntimeEvidence 字段使用 Interface 的原字段名和原始值；字段不参与当前定位或判断时填写 `none`。
- `expected_presence` 只声明对应 Journal record 预期出现或不应出现，不能写成最终通过或失败结论。
- `signal_refs` 只关联对应 `SR-*`；本文件不复制 Signal expectation、预期值、原因说明或实际 Signal。
- Behavioral 命令的操作 contract 由 Tool Skill 定义，当前 RBT 的执行顺序由 Domain Skill 定义；本文件只记录可与 Campaign Journal 对照的预期 records 和相对顺序。
- 预期 Journal records 只能写入上面的表格；不得用散文或项目符号替代表格行。
- Frontmatter 与 `Expected State` 中的 `status`、`completion_state` 必须完全一致。

---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 的全部预期 Signal 与代码证据链模板。
artifact_type: RBTSignalExpected
artifact_version: 1
status: draft
completion_state: partial
---

# Signal Expected

## Expected State

- status: <填写 draft、ready 或 blocked>
- completion_state: <填写 partial、complete 或 blocked>
- bdd_ref: E-BDD-001
- blocking_items: <无阻塞项时填写 none；否则说明阻塞事实>
- limitations: <无已知限制时填写 none；否则说明适用边界>

## Expected Signals

每个可独立定位和判断的 Signal expectation 使用唯一 `SR-*`，并在下表写入一行。当前执行计划使用的全部 Signal 预期都必须登记，包括预期出现和预期不应出现的 Signal。

| sr_id | signal_ref | expected_presence | record_match | source_match | projection_fields | jr_refs | bdd_refs | code_refs | observation_window | limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SR-001 | <填写能解释本预期的最具体 Signal Skill identity 原始值> | <填写 present 或 absent> | <按 signal_ref Interface 填写用于定位 record 的原字段和值> | <按 Interface 填写 source field / operator / value；不适用时填写 none> | <按 Interface 填写字段原名列表；不适用时填写 none> | <填写关联的 JR-* IDs> | <填写 E-BDD-* IDs> | <填写支持该 Signal 出现、定位或整体结构的 E-CODE-* IDs；多个按当前执行链顺序排列> | <需要限定观察时间时填写观察范围；否则填写 none> | <存在特殊限制时填写限制；否则填写 none> |

## Expected Values

每个参与判断的具体字段写入一行。同一 `SR-*` 包含多个预期字段时重复填写 `sr_id`；没有具体字段参与判断时，不为该 `SR-*` 增加行。

| sr_id | field | expected_value | match | not_match | code_refs |
| --- | --- | --- | --- | --- | --- |
| SR-001 | <填写 signal_ref Interface 定义的字段原名> | <填写具体预期原始值> | <填写实际值满足预期的明确条件；字段和值保持原样> | <填写实际值不满足预期的明确条件；字段和值保持原样> | <填写直接修改该值或在当前链路中关键间接参与的 E-CODE-* IDs；多个按实际执行顺序排列> |

填写时遵循对应 Signal Interface：Behavior Trace 使用具体 `id` 定位，并把必需的 `result` 写入 Expected Values；`variantId` 和 `fallbackReason` 只在参与判断时增加。Error 使用 `expected_presence` 声明应出现或不应出现，`error` 只在参与判断时增加。State Snapshot 的 `record_match` 必须包含 `sourceId` 和 `captureId`，`source_match` 与 `projection_fields` 使用其 Interface 定义，Expected Values 中的字段使用 `data.<field>`。

## Signal Boundary

- 本文件只保存预期 Signal、具体值和匹配规则，不保存实际 Signal query result、Runtime 命令或 campaign journal。
- `signal_ref` 必须指向能解释当前预期的最具体 Signal Interface；`record_match`、`source_match`、`projection_fields` 和 Expected Values 必须使用该 Interface 的原字段名和语义，不建立包装字段。
- 每个 `SR-*` 必须有 expectation 级 `code_refs`，用于支持该 Signal 的出现、定位或整体结构；`Expected Values.code_refs` 只用于支持具体字段值，两者可以引用相同或不同的 `E-CODE-*`。
- 当前执行计划声明的所有 Signal 预期都必须写入本文件；不得只保留最终 state snapshot 而遗漏 behavior trace、预期 error 或预期不应出现的 error。
- Expected Values 必须填写可以直接比较的字段和值；不能只写“状态正确”一类没有值的描述。
- Expected Values 中的 `match` 和 `not_match` 只表达该字段值的判断条件，不表达本次执行已经通过或失败。
- 两个表中的 `code_refs` 只能指向当前执行链路中直接修改目标状态或关键间接参与的代码段，并且必须引用 `code-evidence.md` 中已有的 `E-CODE-*`；多个 ID 按这些代码段在当前链路中的实际执行顺序排列，不得罗列只有概念关联的代码。
- 本文件不保存 Via 产生的 match / not-match / unresolved 事实；它只保存 Executor 执行前完成的预期作业。
- Signal expectation 和参与判断的具体值只能写入上面的两个表格；不得用散文或项目符号替代表格行。
- Frontmatter 与 `Expected State` 中的 `status`、`completion_state` 必须完全一致。

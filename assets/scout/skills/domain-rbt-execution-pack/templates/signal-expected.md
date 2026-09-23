---
scout:
  resource:
    requirement: required
    description: 可仅通过 campaign 历史 evidence 整体核验的完整 Signal 预期模板。
artifact_type: RBTSignalExpected
artifact_version: 4
bdd_ref: E-BDD-001
---

# Signal Expected

每个 `SR-*` 是一条完整预期；其含义、范围、字段和判定必须足以让 Reviewer 直接比较查询证据。按稳定声明顺序重复以下结构。

## SR-001

- signal_ref: signal-rbt-evidence
- claim: <该 Evidence 要证明的具体业务事实>
- bdd_refs: <E-BDD-001 中对应的 G-*/W-*/T-* locators>
- expected_presence: <present 或 absent>
- observation_scope: <campaign/scenario、观察边界及查询证据如何确认该边界；absence 还须说明如何确认实际观察与完整范围>
- code_refs: <Executor 已保存的 E-CODE-*；仅追溯依据，不要求 Reviewer 回读源码>
- limitations: <没有限制时为 none>

### Fields

| field | role | expected_value | comparison |
| --- | --- | --- | --- |
| campaignId | locate | <本次 campaignId> | exact |
| scenarioId | locate | <本次 scenarioId> | exact |
| <实际 record 字段或 data.<field>> | <locate 或 assert> | <具体预期值、业务状态或明确的实际字段关系> | <按 Interface 选择比较类型并写清必要条件> |

## Rules

- 以 `signal-rbt-evidence` 为唯一声明语义；顶层 identity、result、error 与 `data.*` 同属一张 Fields 表。
- `comparison` 按 Interface 的 Comparison Semantics 填写，`expected_value` 与之共同表达执行前条件；不将状态语义猜成精确序列化值，不留给 Reviewer 临时选择比较规则。
- `locate` 定位候选，`assert` 判断候选；不以断言值过滤掉错误 records。
- 所有参与判定的字段、范围与关系必须能由当前 campaign 查询返回的 metadata/evidence 核验；不声明需要 execution history 或 codebase 补证的字段。
- 多个字段可以共同判断同一条 record；多个 record 的值不得拼成一条满足预期的 record。
- BDD/code refs 只由 SR 指向底层 artifact；本文件不维护 JR、HI 或 Review Result 的反向引用。
- 本文件保存执行前预期，不保存 actual evidence、query result 或 Via 比较结论。

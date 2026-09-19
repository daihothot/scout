---
assetKind: scout.skill
name: signal-rbt-evidence
description: 声明一条可由 RBT campaign 历史 evidence 整体定位和比较的完整预期，或解释其原始字段时使用。
id: signal-rbt-evidence
version: 0.5.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, unity, rbt, evidence, campaign-journal]
devices: [any]
summary: 定义完整 Evidence expectation；所有实际比较值都来自 campaign 查询。
---

# RBT Evidence Signal

本技能定义一条完整 Evidence 的声明 contract。Executor 从当前业务源码建立预期；Reviewer 使用相同声明与 campaign 查询的实际 evidence 整体比对。定位字段、结果字段和业务字段属于同一条预期，不拆成基础 Signal 与附加语义层。

## Ownership

- Interface 定义预期应包含什么；Via 定义如何取得并比较实际 evidence。
- Executor Domain Skill 负责沿当前版本的 `rbt-hook`、`rbt-evidence`、`rbt-example`、`rbt-ref` 找到业务依据，并将字段含义、具体值与比较边界写清楚。
- Reviewer 消费完整预期；BDD/code refs 仅保留追溯引用，不沿引用读取 BDD、源码依据 artifact 或 codebase 来重建预期。
- 本技能不绑定具体 Node、Variant、EvidenceSource 或业务模块。

## Evidence Fields

以下字段与 `data.*` 是同一条 campaign Evidence record 的组成部分：

| field | type | meaning |
| --- | --- | --- |
| `campaignId` | string | 所属 campaign。 |
| `scenarioId` | string | 所属 scenario。 |
| `correlationId` | string | 命令或业务调用关联 identity。 |
| `traceId` | string | 当前 trace identity。 |
| `parentTraceId` | string | 父 trace identity。 |
| `sequence` | integer | Journal 实际写入序号。 |
| `timestamp` | string | Journal 实际写入 UTC 时间。 |
| `kind` | string | Evidence 类型的 wire name。 |
| `sourceId` | string | EvidenceSource identity。 |
| `captureId` | string | capture identity。 |
| `id` | string | Behavior node 或 producer 声明的对象 identity。 |
| `variantId` | string | 实际 variant identity。 |
| `result` | string | 原始结果分类。 |
| `fallbackReason` | string | 原始回退原因。 |
| `error` | string | 原始错误文本。 |
| `data` | object | 原始业务字段；以 `data.<field>` 引用。 |

- 可选 string 的 wire 空值是 `""`，`data` 的空值是 `{}`；缺字段、`null`、空值和类型错误分别保留。
- 同一 record 的字段不得由相邻 record、activation 参数、执行文件或源码默认值补齐。
- `sequence` 表示同一 Journal 内的写入先后，不是数组下标、业务因果或持续时长。
- Runtime 分配的 trace、correlation、sequence 和 timestamp 不预造具体值；需要比较关系时必须使用实际查询值与明确声明的关系。

### `behavior_trace.result`

当 `kind` 为 `behavior_trace` 时，`result` 只使用下列正式 wire 值：

| value | meaning |
| --- | --- |
| `default` | 默认 invoker 成功完成。 |
| `override_result` | Variant 返回 `OverrideResult`。 |
| `blocked` | Variant 返回 `Block`。 |
| `fallback` | Variant 返回 `ContinueDefault` 或 `FallbackToDefault`。 |

Executor 声明 `behavior_trace` 的 `result` 时必须使用表中的原始值，不得缩写、改名或按自然语言自行概括。其它 `kind` 不套用这组取值；其 `result` 保留 campaign evidence 返回的原始值。

## Complete Expectation

| item | requirement |
| --- | --- |
| `signal_ref` | 固定为 `signal-rbt-evidence`。 |
| `claim` | 这条 evidence 要证明的具体业务事实；Reviewer 无需读源码即可理解。 |
| `expected_presence` | `present` 或 `absent`，作用于整条预期。 |
| `observation_scope` | 当前 campaign/scenario 内的观察范围、关联边界，以及如何从查询结果确认该范围有效。 |
| `fields` | 一张完整字段表，覆盖定位和业务断言；所有路径都能在查询返回的 evidence 中读取。 |
| `code_refs` | Executor 已保存的当前版本源码证据引用；Reviewer 只保留引用，不展开来源。 |
| `limitations` | 未能由查询证据覆盖的边界；没有时为 `none`。 |

`fields` 使用同一结构：

| field | role | expected_value | comparison |
| --- | --- | --- | --- |
| `<原始字段路径>` | `locate` 或 `assert` | <具体预期值、业务状态或实际字段关系> | <Comparison Semantics 中的类型及必要条件> |

- `locate` 用于找到目标 record，例如 campaign、scenario、Node、capture 或业务 key。
- `assert` 用于判断目标 record 的结果，例如实际 variant、result 和业务值。角色由当前 BDD 的比较目的决定，不由字段名固定。
- 两种 role 只区分定位与判断用途，仍然属于同一份完整声明。不得先按断言值过滤记录，再把不匹配改称为“记录不存在”。
- 所有字段条件必须在同一实际 record 上判断；一个 SR 可以包含多项字段断言。不同 records 不能拼成一条满足预期的 record。
- `present` 表示存在满足完整声明的 record；`absent` 表示在已确认的观察范围内不存在满足完整声明的 record。
- 多候选保留全部实际结果；不能擅自选择第一条、最后一条或最大 sequence 来制造匹配。

## Comparison Semantics

Executor 按要证明的事实选择比较语义，写入现有 `expected_value` 与 `comparison` 列；不将所有业务断言默认写成序列化值精确相等。比较类型和必要条件必须在执行前明确，Reviewer 不在看到实际结果后改换规则。

| comparison | 声明要求与含义 |
| --- | --- |
| `exact` | 声明具体值及类型；类型和值一致，对象键顺序无关，数组元素顺序保留，不做隐式类型转换。 |
| `empty` | 声明判空对象与含义。若断言是“容器无成员”，`[]` 与 `{}` 均满足；若断言是“字符串无字符”，仅 `""` 满足。表示类型本身有要求时使用 `exact`。 |
| `absent` | 断言指定字段路径不存在；必须能确认该字段的可见范围完整。与整条记录的 `expected_presence: absent` 分开表达。 |
| `contains` | 明确是字符串包含子串、数组包含指定成员，还是对象包含指定键值；指定部分按 `exact` 比较，允许其余内容存在。 |
| `set_equals` | 声明预期成员集合；忽略数组成员顺序与重复次数，成员按 `exact` 比较。顺序或次数属于业务要求时使用 `exact` 或 `predicate`。 |
| `predicate` | 声明可由查询证据直接判定的条件、范围或实际字段关系；需要时写清类型、单位、边界及转换依据，不使用“意思相近”等不可核验条件。 |

- 声明 identity、`kind` 和正式结果枚举的具体值时必须用 `exact`；`locate` / `assert` 不改变这一要求。Runtime 分配的 identity 只声明有依据的实际关联关系，不预造值。
- 业务要求指定精确值或类型时使用 `exact`；只要求状态、包含、集合或范围时声明对应语义，不额外要求无关的序列化形态。
- `empty` 不自动包含 `null`、字段缺失、`0`、`false` 或空白字符串；`absent` 不等于字段值为 `null`。其它等价关系须由 Executor 根据当前业务依据事先明确条件。
- 正式 wire 枚举由本 Interface 提供，业务值和比较依据来自当前业务 Hook/Evidence 声明；不要求为编写断言读取 RBT Runtime 内部实现。不确定的表示不能猜成 `exact`，必需语义仍无法明确时按 Domain 的缺口边界处理。

## Observability Boundary

- 每个参与结果的字段、范围与关系，都必须能够由 campaign 查询返回的 metadata/evidence 核验；预期正文、source refs 和执行计划本身不是实际值。
- 不声明只能从 execution history 的 command request/result 才能取得的断言；这类审计资料只用于定位本次执行。
- 如果一项业务前提需要另一条 Evidence，Executor 应声明那条完整 SR，并由 Journal/Domain 表达实际业务关系；不新建附加事实层。
- 查询没有某条 record 只能先证明“该查询未返回记录”。要据此证明业务 absence，必须能从 campaign evidence 确认目标观察确实发生、范围完整且未被错误过滤。
- 例如“未采集”和“完整采集结果为空”在当前 evidence 中不可区分时，应保留能力缺口，不能靠源码、capture 配置或命令成功补成 absence。
- Executor 在执行前发现必需事实无法采集或声明时，按 Domain 的 Human Input 边界处理；Reviewer 在实际查询中无法核验时，交给 Via 保留 unresolved。

## Integrity Rules

- 一条预期包含完整的业务含义、观察范围、定位条件和判定条件；不依赖 Reviewer 补读 codebase 或猜测未声明语义。
- 不为具体 kind 或业务模块创建派生 Signal contract。
- Interface 不产生 match/not_match/unresolved 或 BDD 结论；它只定义完整声明及原始证据语义。

---
assetKind: scout.skill
name: signal-rbt-evidence
description: 解释 RBT Campaign Journal 中一条 RuntimeEvidence 的公共字段，或声明预期 RBT Signal 时使用。
id: signal-rbt-evidence
version: 0.1.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, unity, rbt, evidence, campaign-journal]
devices: [any]
summary: 定义 RBT Campaign Journal evidence 的基础 interface 和预期声明 contract。
---

# RBT Evidence Signal

## Terms

- `<role>`：当前读取和使用本 Signal 的实际 Scout role。
- `RBT`：runtime behavioral test。
- `RBT Runtime`：Guru SDK 中产生、关联并保存 Behavioral evidence 的运行时组件。
- `Campaign Journal`：RBT Runtime 保存的历史 evidence 集合，可以包含多个 campaign 的 records。
- `RuntimeEvidence record`：Campaign Journal 中的一条 evidence；后文简称 `record`。
- `evidence producer`：在 record 写入 Campaign Journal 前创建或填写 `RuntimeEvidence` 的源码路径，例如 Behavior Engine 或一个 EvidenceSource。
- `origin command`：已经通过匹配的 command request/result 确认直接触发或承载这条 evidence 的命令，不是后来用于读取 Campaign Journal 的 query command。
- `EvidenceSource`：由源码注册、能够返回某类运行时 evidence 的来源。
- `capture declaration`：scenario 中声明的一次 EvidenceSource 采集，包含 `captureId`、`sourceId` 和采集条件。
- `Behavior node`：由源码注册、可以执行默认逻辑或 variant 的行为节点。
- `variant`：由源码注册并通过 scenario activation 选中的 Behavior node 替代行为。
- `interface`：本 Skill 定义的公共结果结构和字段含义。
- `derived Signal`：通过明确的 composition chain 在本 Skill contract 基础上收窄某个 `kind`、EvidenceSource 或业务 `data` 的 Signal Skill；链中的每一层只直接依赖它直接扩展的 contract。
- `Signal expectation`：<role> 在执行前声明希望出现或不应出现的一条 Signal；后文简称 `expectation`。

当 <role> 需要读懂 RBT Campaign Journal 中一条已经保存的 `RuntimeEvidence` record，或需要在执行前声明预期 RBT Signal 时使用本技能。

本技能解释这条 record 的公共 interface，并定义所有 RBT Signal 共用的 expectation 骨架。具体 Signal 要求预期哪些字段，由对应 derived Signal 定义；如何获取和比较实际 Signal，由对应 Via Signal 定义。

## Skill Type

- type: signal
- layout: compact
- contract role: interface
- note: 本技能定义实现无关的 RBT Campaign Journal evidence 基础 contract。

## Core Use

使用本技能处理：

- 读懂一条 Journal evidence 的身份、关联对象、写入顺序、时间、类型、内容和原始位置。
- 分清字段是由外部请求传入、源码注册、evidence producer 提供，还是由 RBT Runtime 写入。
- 根据实际字段返回 campaign、scenario、关联调用、已确认的 origin command、EvidenceSource、capture declaration、Behavior node 或 variant。
- 为解释具体 `kind` 或业务 `data` 的 derived Signal 提供公共结果。
- 按实际 Signal identity 声明预期出现或不应出现的 Signal，以及用来定位和判断的字段。

职责边界：

- 外部 ID 的格式、命令调用和具体业务字段分别由调用方、Tool Skill 或更具体的 Signal contract 负责；本 Skill 只保留 Runtime 原始字段语义。
- 具体 `kind`、业务 `data` 和 expectation 的获取或比较由对应的 derived / Via Signal 负责。

## Interface Overview

一条 RBT Evidence Signal 对应 Campaign Journal 中一条实际 `RuntimeEvidence` record。字段最直接的用途是：

```text
campaignId                 -> 找到所属 campaign
scenarioId                 -> 找到所属 scenario
correlationId              -> 找到 origin command 或关联调用
sourceId + captureId       -> 找到 EvidenceSource 和 capture declaration
id + variantId             -> 找到 Behavior node 和实际命中的 variant
sequence                   -> 比较 records 写入 Campaign Journal 的先后
kind                       -> 选择对应的 derived Signal
```

完整 interface 就是 RBT Runtime 返回的 `RuntimeEvidence` record：

```text
campaignId
scenarioId
correlationId
traceId
parentTraceId
sequence
timestamp
kind
sourceId
captureId
id
variantId
result
fallbackReason
error
data
```

RBT Runtime 可选 string 字段没有值时序列化为 `""`，`data` 没有内容时序列化为 `{}`。字段缺失、`null`、类型错误和正式空值是四种不同事实，不能互相替换。

## Inputs

### I-001: RuntimeEvidence Record
---

描述：

- 一条已经写入 Campaign Journal，并保留 RBT Runtime 全部返回字段实际值的 `RuntimeEvidence` record。

Required：完整 RuntimeEvidence object 及其原始字段和值。

Optional：来源方提供的 command / invocation 关联事实；它只用于追踪，不替换 record。

Missing：record 缺失、截断、字段类型错误或无法读取时，不能形成完整基础 Signal；不得用 expectation 或其它 record 补齐。

Confirmation：确认该 object 来自 RBT Runtime 返回的 record，并保留字段名和值；外部 ID 格式和业务含义不在本输入中确认。

注意事项：

- 本 interface 只解释现有 record，不补造外部 ID、执行结果、顺序或业务数据。
- 只有摘录或 <role> 自己转述的字段不能替代 RBT Runtime 返回的完整 record。

## Field Contract

### `campaignId`

- 类型与示例：string，`campaign-account-restore-001`；示例不规定 ID 格式。
- 含义：保存这条 record 的 campaign identity。
- 来源：通常来自 `behavior.campaign.start` 请求中的 `campaignId`。capture 路径会写入当前 campaign ID；Behavior Engine 产生的 record 通常由 RBT Runtime 根据同一 `scenarioId` 关联到正在运行的 campaign。evidence producer 也可以预先提供该值。
- RBT Runtime 行为：关联或保留 campaign ID，但不规定其格式。producer 提供的非空 ID 已指向已注册 campaign 时会保留；否则可以按同一 scenario 关联正在运行的 campaign。
- <role> 的追踪用途：与 campaign start result、campaign metadata 和同值 records 对照，缩小到同一次 campaign。
- 空值：`""` 表示 RBT Runtime 没有为这条 record 得到可用的 campaign identity，不能支持 campaign-specific 判断。
- 边界：非空值只表示 record 声明属于该 campaign；ID 的格式、唯一性和业务有效性由 Domain Skill 判断。

### `scenarioId`

- 类型与示例：string，`scenario-account-restore-001`；示例不规定 ID 格式。
- 含义：这条 record 所属的 scenario identity。
- 来源：外部请求把该值提供给 scenario activation、campaign、trigger context 或 capture context，再由 evidence producer 或 capture 路径写入 record。
- RBT Runtime 行为：在命令上下文与 record 之间传递或保留该值，不重新定义其格式。
- <role> 的追踪用途：与 scenario activation、origin command、capture declaration 和其它同值 records 对照。
- 空值：`""` 表示这条 record 没有可用的 scenario identity。
- 边界：两个 records 值相同，只能证明它们声明了同一 scenario，不能单独证明因果关系。

### `correlationId`

- 类型与示例：string，`trigger-account-restore-001`；示例不规定 ID 格式。
- 含义：产生这条 evidence 的 origin command 或业务调用所携带的关联 ID。
- 来源：可以来自 trigger command、EvidenceSource capture command、业务代码创建的 `BehaviorContext`，或其它 evidence producer 提供的调用关联 ID。
- RBT Runtime 行为：把已有的调用关联 ID 带入执行上下文或 record，并在写入 Journal 时保留；不会把后续 query command 的 `correlationId` 写回历史 record。
- <role> 的追踪用途：优先通过该值查找关联调用；只有找到匹配的 command request/result，才能确认它对应 origin command。
- 空值：`""` 表示不能通过该字段定位关联调用。
- 边界：非空值本身不证明关联对象一定是 command。query command 也有自己的 `correlationId`，但它只标识查询调用，不是本字段。

### `traceId`

- 类型与示例：string，`trace-00042`；示例不规定 ID 格式。
- 含义：evidence producer 声明的当前 trace identity。
- 来源：只来自 evidence producer；RBT Runtime 当前的 Behavior trace、Behavior error 和已检查的 state snapshot producers 都不会自动填写它。
- RBT Runtime 行为：只保留 producer 提供的值，不生成、不补齐、不改写。
- <role> 的追踪用途：非空时，与其它同 `traceId` records 或外部 trace 事实对照。
- 空值：`""` 表示 producer 没有提供 trace identity；在当前 producers 中是正常值，不表示 record 无效。

### `parentTraceId`

- 类型与示例：string，`trace-00041`；示例不规定 ID 格式。
- 含义：evidence producer 声明的父 trace identity。
- 来源：只来自 evidence producer；当前已检查的 producers 不会自动填写它。
- RBT Runtime 行为：只保留 producer 提供的值，不生成 trace tree。
- <role> 的追踪用途：当前 record 的 `traceId` 与 `parentTraceId` 都非空时，保留 producer 声明的父子引用并返回外部 trace。
- 空值：`""` 表示 producer 没有声明父 trace；除非业务 contract 另有证据，否则不能解释成 root trace。

### `sequence`

- 类型与示例：integer，`42`。
- 含义：这条 record 在当前 Campaign Journal 中的写入序号。
- 来源：由 RBT Runtime 保存 Campaign Journal 的组件在写入时分配。
- RBT Runtime 行为：覆盖 evidence producer 原值并分配下一个递增序号。序号属于当前整个 Campaign Journal，不会为每个 campaign 重新从 `1` 开始。
- <role> 的追踪用途：只有两条 records 来自同一 Campaign Journal 时，才用较小值表示较早写入。
- 空值：不是可选 string，没有 `""` 语义；缺失、`null`、非 integer 或数组下标都不是有效值。
- 边界：它不是数组 index；较早写入也不自动证明业务因果。

### `timestamp`

- 类型与示例：ISO 8601 string，`2026-09-04T08:15:30.1234567Z`。
- 含义：record 写入 Campaign Journal 时的 UTC 时间。
- 来源：由 RBT Runtime 保存 Campaign Journal 的组件在写入时取得。
- RBT Runtime 行为：覆盖 producer 原值，并按 round-trip ISO 8601 格式序列化。
- <role> 的追踪用途：定位 Journal 接收 record 的时间，并辅助检查相距较远的 records。
- 空值：没有正式空字符串语义；空值或不可解析值表示 record 不能完整满足本 interface。
- 边界：不是业务动作开始时间；比较 Journal 写入先后优先使用同一 Journal 的 `sequence`。

### `kind`

- 类型与示例：string，`state_snapshot`。
- 含义：这条 record 表示哪一类 evidence。
- 来源：一般由 evidence producer 选择；EvidenceSource capture 写入 Journal 时，RBT Runtime 使用实际 EvidenceSource descriptor 声明的 kind 覆盖原值。
- RBT Runtime 行为：返回以下实际值。
- <role> 的追踪用途：选择能够解释该类 record 的 derived Signal。
- 空值：没有正式空字符串语义；未知或空 kind 不能形成完整的本 interface。

Schema 合法值及说明：

| value | 产生条件 |
| --- | --- |
| `behavior_trace` | 同步或异步返回值节点的默认 invoker 成功，或匹配的 variant 返回 `OverrideResult`、`Block`、`ContinueDefault`、`FallbackToDefault`。fire-and-forget 默认 invoker 成功时不写 `default` trace。 |
| `analytics_event` | Runtime schema 允许的 evidence kind；具体 producer 语义由对应 implementation / derived Signal 提供。 |
| `structured_log` | Runtime schema 允许的 evidence kind；具体 producer 语义由对应 implementation / derived Signal 提供。 |
| `response_payload` | Runtime schema 允许的 evidence kind；具体 producer 语义由对应 implementation / derived Signal 提供。 |
| `state_snapshot` | EvidenceSource 返回状态快照，随后由 capture 写入 Journal。`data` 由对应 derived Signal 解释。 |
| `websocket_response` | Runtime schema 允许的 evidence kind；具体 producer 语义由对应 implementation / derived Signal 提供。 |
| `error` | variant 抛出异常，或异步、fire-and-forget 默认 invoker 抛出异常。同步默认 invoker 的异常当前不写该 record。 |

除表中已核对的 Behavior trace、State Snapshot 和 Error producer 外，本 Skill 不补写其它 kind 的 producer 条件；它们仍是 schema 合法的 wire value。

### `sourceId`

- 类型与示例：string，`account.account_auth.state`；示例不规定其它 source 的命名。
- 含义：产生这条 evidence 的 EvidenceSource identity。
- 来源：EvidenceSource descriptor 在源码注册时声明；注册代码没有显式提供 source ID 时，descriptor 使用由 domain、category 和 segments 构建的 BehaviorKey。
- RBT Runtime 行为：EvidenceSource capture 写入 Journal 时使用实际 descriptor 对应的 source ID；Behavior trace/error 不来自 EvidenceSource，当前通常为空。
- <role> 的追踪用途：返回 EvidenceSource registry、scenario capture declaration，并选择解释该 source `data` 的 derived Signal。
- 空值：`""` 表示 record 没有 EvidenceSource identity；对非 EvidenceSource evidence 是正常值。

### `captureId`

- 类型与示例：string，`account-state-after-trigger`；示例不规定 ID 格式。
- 含义：scenario 中触发本次 EvidenceSource 采集的 capture declaration identity。
- 来源：外部调用方在 scenario evidence capture declaration 中提供。
- RBT Runtime 行为：执行对应 capture 时写入每条采集 record 并保留，不重新生成 ID。
- <role> 的追踪用途：在 scenario activation 中找到具体 capture declaration，并把同一次 capture 返回的 records 放在一起检查。
- 空值：`""` 表示 record 没有 capture declaration identity；Behavior trace/error 通常为空。

### `id`

- 类型与示例：string，`account.account_auth.load_account`。
- 含义：record 关联的 Behavior node key。
- 来源：Behavior node 由源码使用 BehaviorKey 注册；Behavior Engine 记录 trace/error 时写入实际执行节点的 key。
- RBT Runtime 行为：保存并序列化该 key，不根据文本猜测节点。
- <role> 的追踪用途：返回 Behavior registry、节点源码、scenario activation 和其它同节点 records。
- 空值：`""` 表示 record 没有关联 Behavior node；state snapshot 等 EvidenceSource records 当前通常为空。
- 边界：本 interface 不根据 key 解释节点业务职责。

### `variantId`

- 类型与示例：string，`existing_local_user`。
- 含义：Behavior Engine 实际命中的 variant identity。
- 来源：variant 由源码注册并由 scenario activation 选择；Behavior Engine 写入实际命中的 ID。
- RBT Runtime 行为：保留实际命中值，不根据 activation 期望补写未命中的 variant。
- <role> 的追踪用途：与 node variants 列表、scenario activation 和同一 variant 的其它 records 对照。
- 空值：表示没有命中 variant，或该 kind 与 variant 无关。不能用 activation 中的期望值补齐。

### `result`

- 类型与示例：string，`override_result`。
- 含义：evidence producer 对本条 record 给出的执行结果分类文本。
- 来源：由 evidence producer 写入；RBT Runtime 保存它，但不把它转换成通过、失败或 BDD 结论。
- <role> 的追踪用途：与同一 record 的 `kind`、`id`、`variantId` 和 `fallbackReason` 一起判断实际执行分支，再交给匹配的 derived Signal。
- 空值：`""` 表示 producer 没有提供 result；`error`、`state_snapshot` 等 records 当前通常为空。

当前 Behavior Engine 对 `behavior_trace` 产生以下已知值：

| value | 产生条件 | 后续行为 |
| --- | --- | --- |
| `default` | 同步或异步返回值节点的默认 invoker 成功。 | 表示默认路径完成。fire-and-forget 成功时不产生该值。 |
| `override_result` | variant 返回 `OverrideResult`。 | 同步或异步节点采用 variant 结果并跳过默认 invoker；fire-and-forget 继续执行默认 invoker。 |
| `blocked` | variant 返回 `Block`。 | fire-and-forget 跳过默认 invoker；同步或异步节点继续执行默认 invoker。 |
| `fallback` | variant 返回 `ContinueDefault` 或 `FallbackToDefault`。 | 继续执行默认 invoker。同步或异步成功后再写一条 `default`；fire-and-forget 不写。 |
| `""` | record 不是上述 Behavior trace，或 producer 没有填写结果。 | 不能据此判断执行分支。 |

该表只适用于当前 Behavior Engine 的 `behavior_trace`。`ReplacePayload`、`UseFake`、`Delay` 和 `Fail` 当前不会产生新的 Journal `result` 值，不能自行补写。

### `fallbackReason`

- 类型与示例：string，`variant-requested-default`；示例不定义固定枚举。
- 含义：variant 继续或回退默认路径时返回的原始原因。
- 来源：Behavior Engine 从 variant result 读取并写入 `behavior_trace` record。
- RBT Runtime 行为：原样保存，不推导、不补写原因。
- <role> 的追踪用途：只与同一条 `result: fallback` record 的 `id` 和 `variantId` 一起解释为何进入默认路径。

| variant result | `fallbackReason` |
| --- | --- |
| `FallbackToDefault` | variant 提供的原因。 |
| `ContinueDefault` | `""`。 |
| 其它情况 | `""`；不能根据后续 record 反推。 |

### `error`

- 类型与示例：string，`simulated runtime failure`。
- 含义：evidence producer 记录的原始错误文本。
- 来源：Behavior Engine 捕获 variant、异步默认 invoker 或 fire-and-forget 默认 invoker 的异常后，写入 exception message。
- RBT Runtime 行为：原样保存，不为相同文本生成错误 identity，也不按文本分类异常。
- <role> 的追踪用途：与同一 record 的 `correlationId`、`id` 和 `variantId` 对照，返回异常调用和执行位置。
- 空值：表示 producer 没有提供错误文本；不能猜测异常内容。

### `data`

- 类型与示例：object，`{"uid": "debug-account-uid", "accountDataStatus": "Initialized"}`。
- 含义：evidence producer 附加到 record 的结构化数据。
- 来源：由具体 EvidenceSource 或其它 evidence producer 填写。
- RBT Runtime 行为：保存 object；没有内容时序列化为 `{}`，不根据 key 名补充业务语义。
- <role> 的追踪用途：先根据 `kind` 和 `sourceId` 选择 derived Signal，再由它解释字段、取值和判断边界。
- 空值：正式空值是 `{}`；字段缺失、`null`、array 或 string 都不是空 object。
- 边界：业务字段由对应 derived Signal 解释。

## Signal Expectation Contract

一条 expectation 只表示一个可独立定位和判断的预期 Signal。所有 RBT Signal 共用以下结构：

```text
signal_ref
expected_presence
record_match
expected_values
```

| field | 作用 |
| --- | --- |
| `signal_ref` | 实际 Signal Skill identity。应使用能解释当前预期的最具体 Signal，不能在已有 derived Signal 时仍指向本基础 interface。 |
| `expected_presence` | `present` 表示预期存在满足完整声明的 Signal；`absent` 表示预期不存在满足完整声明的 Signal。 |
| `record_match` | 从 Campaign Journal 中定位候选 record 所需的字段和实际值。这些条件先确定“在看哪条 Signal”。 |
| `expected_values` | 对候选 record 中真正参与本次预期判断的字段和值。当 `record_match` 已经完整表达预期，且具体 Signal Interface 不要求额外值时，可以为 `none`。没有声明的字段保留实际值，但不参与该 expectation 的 match / not-match。 |

`record_match` 使用表格声明：

| field | value |
| --- | --- |
| `<RuntimeEvidence field>` | `<用于定位的实际值>` |

`expected_values` 使用表格声明：

| field | expected_value | match | not_match |
| --- | --- | --- | --- |
| `<由 signal_ref 定义的字段>` | `<具体预期值>` | `<实际值满足预期的明确条件>` | `<实际值不满足预期的明确条件>` |

没有额外字段参与判断时写 `expected_values: none`。具体 Signal Interface 已要求必填字段时不能使用 `none`。

声明规则：

- `record_match` 和 `expected_values` 中的字段名由 `signal_ref` 指向的 Interface 定义；本 Skill 不为 derived Signal 补造字段。
- 嵌套 `data` 字段使用原始路径，例如 `data.uid`；不建立另一套字段名。
- `match` 和 `not_match` 必须写成可直接对照实际值的条件，不能只写“正确”、“符合 BDD”或“不符合”。
- 只声明本次 BDD 真正需要判断的值；不需要把 RuntimeEvidence 每个字段重新写一遍。
- 多个独立 Signal、多个节点或同一 Signal 的多个观察点分别声明 expectation；不把它们合并成一条模糊预期。
- expectation 只声明预期，不保存实际 Signal，也不表示比较已经发生。

## Signal Result

- 一条基础 Signal 只表示来源中存在一条符合本 interface 的实际 RuntimeEvidence record。
- 外部 ID 的格式、唯一性和业务有效性不由本 interface 判断。
- 同一 record 只有一个实际 `kind`；kind-specific fields 与 `data` 必须交给匹配的 derived Signal 解释。
- `sequence` 只比较同一 Campaign Journal 的写入顺序；`campaignId` 不会把它改成 campaign 内序号。
- 本 interface 成立不表示 BDD 通过，也不表示任一业务预期已经满足。

## Evidence Rules (Enforcement)

- ER-001：每条 Signal 必须使用同一 RuntimeEvidence record 的全部实际字段和值，不得重命名、删减或补写字段。
- ER-002：具体 `kind`、EvidenceSource 或业务 `data` 必须由一条明确的 derived composition chain 解释；中间 derived Signal 只直接引用它扩展的 contract，不要求每一层重复直接 required 本基础 Interface。
- ER-003：每条 expectation 必须指向实际 Signal Skill identity，并使用该 Interface 定义的 `record_match` 和 `expected_values` 字段。

## Failure Rules (Enforcement)

- FR-001：来源 record 不完整时，不得用猜测值、activation 期望或其它 record 补齐受影响字段。

## Blocking Rules (Enforcement)

- BR-001：来源 record 不可用时，阻塞形成该条 RBT Evidence Signal；单个外部 ID 为空只阻塞依赖该 ID 的追踪，不改变其它字段事实。

## Prohibited Rules (Enforcement)

- PR-001：禁止补造、重排或重新编号 Runtime `sequence`，或用数组下标替代它。
- PR-002：禁止为外部 ID 发明格式、默认值、唯一性或未由来源声明的关联关系。
- PR-003：禁止由本 interface 解释具体业务 `data`、业务结果或 BDD 结论。
- PR-004：禁止用 expectation 中的预期值补写、替换或修正实际 RuntimeEvidence record。

## Checklist

- 每个 interface field 的来源、RBT Runtime 行为、追踪用途、空值含义和适用的已知取值均已确认。
- 多值字段说明了每种已知值在什么情况下产生，没有把一个 producer 的值误写成所有 kinds 的全局 enum。
- `correlationId` 表示 origin command 或调用关联 ID，并且没有与后续 query command 的 `correlationId` 混淆。
- interface 字段名和值与 RBT Runtime 返回的 RuntimeEvidence record 完全一致。
- 外部 ID 的格式没有被本 interface 擅自规定，空字符串也没有被补造。
- 具体 `kind` 和业务字段交给对应 derived Signal。
- expectation 使用最具体 `signal_ref`，只声明定位和判断当前 BDD 所需的字段。

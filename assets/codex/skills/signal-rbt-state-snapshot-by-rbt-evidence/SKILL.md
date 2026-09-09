---
assetKind: scout.skill
name: signal-rbt-state-snapshot-by-rbt-evidence
description: 基于 RBT Evidence 解释 Campaign Journal 中 state_snapshot，或声明 EvidenceSource 采集、字段投影和预期值时使用。
id: signal-rbt-state-snapshot-by-rbt-evidence
version: 0.1.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, unity, rbt, evidence, state-snapshot]
devices: [any]
dependencies:
  skills:
    required: [signal-rbt-evidence]
summary: 基于 RBT Evidence 定义 state_snapshot 的结果、投影和预期 contract。
---

# RBT State Snapshot By RBT Evidence Signal

当需要解释 RBT Campaign Journal 中 `kind: state_snapshot` 的 source、capture 和快照数据时使用本技能。

本技能基于 `signal-rbt-evidence` 收窄状态快照语义；具体业务字段由更具体的 derived Signal 定义。

## Skill Type

- type: signal
- layout: compact
- contract role: derived
- note: 本技能基于 RBT Evidence 基础结果定义 state_snapshot。

## Core Use

使用本技能处理：

- 识别 `kind: state_snapshot` 的 Journal evidence。
- 解释快照的实际 source、capture identity、写入时间和字段可见范围。
- 区分空快照、部分字段、缺失字段和冲突快照。

职责边界：本技能只解释 `state_snapshot` 的原始 source、capture、projection 和预期；具体业务字段、命令调用和业务结论由对应 Skill 负责。

## Inputs

### I-001: State Snapshot Record
---

Required：完整基础 `RuntimeEvidence` record，且 `kind` 为 `state_snapshot`。

Optional：source descriptor、capture declaration 和同一 campaign / scenario 的定位事实。

Missing：缺少 record、`sourceId` 或 `captureId` 无法读取时，不形成该 Signal；不得从 source 名称或其它快照补齐。

Confirmation：确认 `sourceId`、`captureId` 和 `data` 来自同一原始 record；projection 规则只按实际 declaration 验证。

## State Snapshot Contract

适用基础结果必须满足：

```text
signal_ref: signal-rbt-evidence
kind: state_snapshot
```

专有字段：

| field | 语义 |
| --- | --- |
| `sourceId` | 产生该快照的实际 EvidenceSource identity。 |
| `captureId` | 当前 scenario 中声明并执行的实际 capture identity。 |
| `data` | source 在该次 capture 中返回并写入 Journal 的字段集合。 |

## Result Semantics

- 快照只证明 `timestamp` 对应的 Journal 写入点捕获了这些字段和值。
- `data` 中未出现的字段属于未知；不能按 source schema 补入默认值。
- 字段选择产生的部分快照只能用于解释实际保留的字段。
- 同一 source 或 capture 出现多条快照时保留全部候选和各自 `sequence`，不能默认最后一条就是目标结果。
- 状态变化需要至少两个可定位快照或其它直接 evidence；单个快照只表示一个观察点。

## Capture And Projection Semantics

State Snapshot 中的三类条件不能混在一起：

| declaration | 作用 | 发生时机 |
| --- | --- | --- |
| `source_match` | 交给 EvidenceSource 的字段筛选条件；不满足时 source 可以返回零条 record。 | 在字段投影之前。 |
| `projection_fields` | capture declaration 要求 EvidenceSource 保留的 `data` 字段白名单。 | source 筛选通过后。 |
| `expected_values` | 对已写入 Campaign Journal 的投影结果声明预期值。 | <role> 验证 actual Signal 时。 |

- `source_match` 使用 EvidenceSource descriptor 声明的 field 和 operator；它不表示已经观察到匹配值。
- `projection_fields` 只能使用 descriptor 中可选择的字段。非空列表表示显式投影；空列表表示 capture 没有要求字段白名单，不等于预期 `data` 为空。
- 具体 EvidenceSource 负责实现字段投影。State Snapshot 必须保留它实际返回的 `data`，不能按 declaration 自行删字段。
- `projection_fields` 为空时表示不应用字段白名单，实际返回的全部 `data` 字段都可参与预期；非空时，参与判断的每个 `data.<field>` 必须出现在投影列表中，不能从代码默认值或其它快照补齐。

## State Snapshot Expectation

本 Signal 使用 `signal-rbt-evidence` 的 expectation 骨架，并增加 `source_match` 和 `projection_fields`：

- `signal_ref` 固定为 `signal-rbt-state-snapshot-by-rbt-evidence` 或更具体的业务 State Snapshot Signal，对应的固定条件是 `kind: state_snapshot`。
- `record_match` 必须包含实际 `sourceId` 和 `captureId`；这两个字段用来定位已写入 Journal 的 capture 结果。
- `source_match` 保存当前 capture declaration 实际要求的筛选字段、operator 和值；没有筛选时明确写 `none`。
- `projection_fields` 保存当前 capture declaration 应投影的字段；用字段集合解释，不依赖列表顺序。
- `expected_values` 使用 `data.<field>` 声明具体投影值，具体字段的类型和业务语义由更具体的 derived Signal 定义。

泛化示例：

```text
signal_ref: <specific-state-snapshot-signal>
expected_presence: present
record_match:
  sourceId = <evidence-source-id>
  captureId = <capture-id>
source_match: <field/operator/value entries | none>
projection_fields: [<field-a>, <field-b>]
expected_values:
  data.<field-a> = <expected-value-a>
  data.<field-b> = <expected-value-b>
```

## Evidence Rules (Enforcement)

- ER-001：State Snapshot 必须保留基础 evidence 的 `campaignId`、`sequence`、`sourceId`、`captureId` 和 `data`；原始定位信息由 Via 在 record 外保存。
- ER-002：只有基于本 contract 的具体 derived Signal 可以解释 `data` 中的业务字段。
- ER-003：State Snapshot expectation 必须同时声明 capture 定位、source 筛选、字段投影和当前 BDD 需要的具体预期值。

## Failure Rules (Enforcement)

- FR-001：`kind` 不匹配、`sourceId` 缺失或快照 record 无法定位时，不形成 State Snapshot Signal。

## Prohibited Rules (Enforcement)

- PR-001：禁止从 source 名称猜测未由具体 Signal 定义的业务语义。
- PR-002：禁止把单个快照改写成完整业务执行路径或状态变化证明。

## Checklist

- 基础 evidence 的 kind 是 `state_snapshot`。
- `sourceId`、`captureId`、`data` 和 `sequence` 来自同一实际 record；原始定位信息由 Via 在 record 外保留。
- 缺失、部分字段和多条候选保持真实语义。
- 具体业务字段交给更具体的 derived Signal。
- expectation 分开了 source 筛选、字段投影和投影后的预期值。

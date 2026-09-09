---
assetKind: scout.skill
name: signal-rbt-error-by-rbt-evidence
description: 基于 RBT Evidence 解释 Campaign Journal 中 error evidence，或声明预期出现或不应出现的错误时使用。
id: signal-rbt-error-by-rbt-evidence
version: 0.1.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, unity, rbt, evidence, error]
devices: [any]
dependencies:
  skills:
    required: [signal-rbt-evidence]
summary: 基于 RBT Evidence 定义 error record 的结果和预期 contract。
---

# RBT Error By RBT Evidence Signal

当需要解释 RBT Campaign Journal 中 `kind: error` 的节点、variant 和错误文本时使用本技能。

本技能基于 `signal-rbt-evidence` 收窄 Runtime error evidence；不定义异常处理、fallback 行为或 BDD 结论。

## Skill Type

- type: signal
- layout: compact
- contract role: derived
- note: 本技能基于 RBT Evidence 基础结果定义 error evidence。

## Core Use

使用本技能处理：

- 识别 `kind: error` 的 Journal evidence。
- 解释发生错误的 Behavior node、相关 variant 和 Runtime 保存的错误文本。
- 将 error 与相邻 trace 或 snapshot 保持为不同 evidence。

职责边界：本技能只解释 `error` 的原始字段和预期；错误处理、后续状态和业务结论由对应 Skill 负责。

## Inputs

### I-001: Error Record
---

Required：完整基础 `RuntimeEvidence` record，且 `kind` 为 `error`。

Optional：同一节点、variant、campaign 或调用关联事实，用于限定错误范围。

Missing：缺少 record、`error` 无法读取或来源不完整时，不形成该 Signal；不得从相邻 trace 补齐。

Confirmation：确认 `id`、`variantId` 和 `error` 来自同一原始 record；是否恢复或继续由其它 evidence 证明。

## Error Evidence Contract

适用基础结果必须满足：

```text
signal_ref: signal-rbt-evidence
kind: error
```

专有字段：

| field | 语义 |
| --- | --- |
| `id` | 发生错误时 Runtime 记录的 BehaviorKey；没有时保持未知。 |
| `variantId` | 与错误关联的 variant identity；没有时保持未知。 |
| `error` | Runtime 实际保存的错误文本。 |

## Result Semantics

- Error Signal 只证明该错误 record 被写入 Journal。
- 相同错误文本不证明两条 error 来自同一异常实例或同一根因。
- error 后是否回退默认路径，必须由独立的后续 trace、snapshot 或其它 evidence 证明。
- `id` 或 `variantId` 为空时不能从相邻 record 自动补齐。

## Error Expectation

本 Signal 使用 `signal-rbt-evidence` 的 expectation 骨架，并补充以下规则：

- `signal_ref` 固定为 `signal-rbt-error-by-rbt-evidence`，对应的固定条件是 `kind: error`。
- `expected_presence: present` 表示当前 BDD 把符合声明的 error 当作预期行为；`expected_presence: absent` 表示该 error 在当前选定范围内不应出现。
- `record_match` 至少声明足以界定错误范围的字段。已知节点时使用 `id`；只在 BDD 关心特定 variant 时增加 `variantId`。
- 错误文本参与判断时，在 `expected_values` 声明 `error` 的具体期望值以及 match / not-match 条件。不关心文本时不为了填满表格而声明它。
- `present` 的 error 不等于 BDD 失败，`absent` 预期下出现 error 也只形成 Signal not-match；最终业务含义不属于本 Interface。

泛化示例：

```text
signal_ref: signal-rbt-error-by-rbt-evidence
expected_presence: <present | absent>
record_match:
  id = <expected-node-id>
expected_values:
  error = <expected-error-text-or-pattern>  # 只有错误文本参与判断时声明
```

## Evidence Rules (Enforcement)

- ER-001：Error Signal 必须保留基础 evidence 的 `campaignId`、`sequence`、实际关联字段和 `error`；原始定位信息由 Via 在 record 外保存。
- ER-002：Error expectation 必须明确 `expected_presence` 并给出足以限定当前错误范围的 `record_match`。

## Failure Rules (Enforcement)

- FR-001：`kind` 不匹配、`error` 缺失或 record 无法定位时，不形成 RBT Error Signal。

## Prohibited Rules (Enforcement)

- PR-001：禁止根据错误文本发明错误 code、异常类型或业务根因。
- PR-002：禁止把 error record 自行改写成 fallback、BDD fail 或业务状态失败。

## Checklist

- 基础 evidence 的 kind 是 `error`。
- `id`、`variantId`、`error` 和 `sequence` 保持实际值；原始定位信息由 Via 在 record 外保留。
- 错误事实与后续 trace、snapshot 和最终判断没有混为一体。
- expectation 明确了错误应出现或不应出现，且只声明真正参与判断的字段。

---
assetKind: scout.skill
name: signal-rbt-behavior-trace-by-rbt-evidence
description: 基于 RBT Evidence 解释 Campaign Journal 中 behavior_trace，或声明预期节点执行结果时使用。
id: signal-rbt-behavior-trace-by-rbt-evidence
version: 0.1.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, unity, rbt, evidence, behavior-trace]
devices: [any]
dependencies:
  skills:
    required: [signal-rbt-evidence]
summary: 基于 RBT Evidence 定义 behavior_trace 的结果和预期 contract。
---

# RBT Behavior Trace By RBT Evidence Signal

当需要解释 RBT Campaign Journal 中 `kind: behavior_trace` 的节点、variant 和执行结果时使用本技能。

本技能基于 `signal-rbt-evidence` 收窄 Behavior trace 语义；不定义节点执行、Journal 查询或 BDD 结论。

## Skill Type

- type: signal
- layout: compact
- contract role: derived
- note: 本技能基于 RBT Evidence 基础结果定义 behavior_trace。

## Core Use

使用本技能处理：

- 识别 `kind: behavior_trace` 的 Journal evidence。
- 解释实际 Behavior node、variant、result 和 fallback reason。
- 区分默认路径、override、block 和 fallback。

职责边界：本技能只解释 `behavior_trace` 的原始字段和预期；其它 evidence 类型、命令调用和业务结论由对应 Skill 负责。

## Inputs

### I-001: Behavior Trace Record
---

Required：完整基础 `RuntimeEvidence` record，且 `kind` 为 `behavior_trace`。

Optional：同一节点的 scenario、campaign、调用关联和 variant registry 事实，用于缩小定位范围。

Missing：缺少基础 record、`id` 或 `result` 无法读取时，不形成该 Signal；不得从 activation 预期补齐。

Confirmation：确认 `id`、`variantId`、`result` 和 `fallbackReason` 都来自同一原始 record；命令结果和后续业务状态另行确认。

## Behavior Trace Contract

适用基础结果必须满足：

```text
signal_ref: signal-rbt-evidence
kind: behavior_trace
```

专有字段：

| field | 语义 |
| --- | --- |
| `id` | 实际执行的 BehaviorKey。 |
| `variantId` | 命中的实际 variant；默认路径可以为空。 |
| `result` | BehaviorEngine 写入的执行结果分类。 |
| `fallbackReason` | `fallback` 时 Runtime 写入的原因；其它结果通常为空。 |

当前 `result` 的实际值：

| result | 语义 |
| --- | --- |
| `default` | 没有产生终止性 variant 结果，执行了默认路径。 |
| `override_result` | variant 直接提供了返回结果；Sync / Async 节点跳过默认 invoker，FireAndForget 节点仍执行默认 invoker。 |
| `blocked` | variant 返回 Block；FireAndForget 节点跳过默认 invoker，Sync / Async 节点仍执行默认 invoker。 |
| `fallback` | variant 要求继续或回退到默认路径。 |

## Result Semantics

- trace 只证明该节点结果被写入 Journal，不证明节点之后的业务状态已经落地。
- `variantId` 为空且 `result: default` 表示记录的是默认执行结果，不能补造默认 variant identity。
- `fallback` 必须连同实际 `fallbackReason` 解释；原因为空时保持未知。
- variant 抛出的异常由 `kind: error` 的 Signal 解释，不改写为第五种 trace result。

## Behavior Trace Expectation

本 Signal 使用 `signal-rbt-evidence` 的 expectation 骨架，并补充以下规则：

- `signal_ref` 固定为 `signal-rbt-behavior-trace-by-rbt-evidence`，对应的固定条件是 `kind: behavior_trace`。
- `record_match` 必须包含预期节点的具体 `id`。只有当前 BDD 需要限定同一 scenario、campaign 或调用时，才增加 `scenarioId`、`campaignId` 或 `correlationId`。
- `expected_values` 必须声明该节点预期的具体 `result`；不能只写“节点已执行”。
- BDD 关心实际 variant 时声明 `variantId`；预期默认路径时可明确声明 `variantId: ""`。
- 只有预期 `result: fallback` 且回退原因影响判断时，才声明 `fallbackReason`。
- 一个节点的一种预期执行结果是一条 expectation。多节点或同节点多次观察分别声明，顺序交给 Journal expectation。

泛化示例：

```text
signal_ref: signal-rbt-behavior-trace-by-rbt-evidence
expected_presence: present
record_match:
  id = <expected-node-id>
expected_values:
  result = <expected-result>
  variantId = <expected-variant-id>   # 只有参与判断时声明
```

## Evidence Rules (Enforcement)

- ER-001：Behavior trace 必须保留基础 evidence 的 `campaignId`、`sequence`、`id`、`variantId` 和 `result`；原始定位信息由 Via 在 record 外保存。
- ER-002：Behavior Trace expectation 必须声明具体节点 `id` 和具体 `result`；其它字段只在影响当前判断时声明。

## Failure Rules (Enforcement)

- FR-001：`kind` 不匹配、`id` 缺失或 `result` 不是当前 Runtime 实际值时，不形成 Behavior Trace Signal。

## Prohibited Rules (Enforcement)

- PR-001：禁止仅凭 trace 声称返回 payload、最终状态或外部副作用正确。
- PR-002：禁止把 `fallback`、`default` 和 `error` 混为同一结果。

## Checklist

- 基础 evidence 的 kind 是 `behavior_trace`。
- node、variant、result 和 fallback reason 按实际字段解释。
- Runtime `sequence` 保持不变；原始定位信息由 Via 在 record 外保留。
- 没有从 trace 推断未记录的业务结果。
- expectation 明确了节点 `id` 和预期 `result`，没有把未参与判断的字段全部列入。

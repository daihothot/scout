---
assetKind: scout.skill
name: signal-rbt-evidence-via-rbt-behavior
description: 从 JarvisBehavior campaign query 的 Agent 可见结果中定位 RBT Evidence，并验证 signal-rbt-evidence expectation。
id: signal-rbt-evidence-via-rbt-behavior
version: 0.4.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, rbt, evidence, jarvis, campaign, verification]
devices: [any]
dependencies:
  skills:
    required: [signal-rbt-evidence, tool-rbt-behavior]
summary: 从已完成的 campaign query payload 定位 Evidence records，并按 Signal expectation 逐项比较。
---

# RBT Evidence via RBT Behavior

当当前 `<role>` 已取得一次 `JarvisBehavior` campaign query 的成功结果，需要从 historical Campaign Journal 中定位 `signal-rbt-evidence` 并与预期比较时，使用本技能。

本技能只负责从 Agent 可见的工具结果定位基础 Evidence records、校验 `signal-rbt-evidence` interface，并形成基础 expectation 比较。命令输入、调用、成功判定和重试由 `tool-rbt-behavior` 负责；kind-specific 语义和额外事实由对应 Signal 或更具体的 Via 负责。

## Terms

| term | meaning |
| --- | --- |
| Query input | 同一次 Dynamic Tool 调用中的 `{ command: "behavior.campaign.query", payload: {...} }`。 |
| Query output | 同一次调用返回的 `{ status, command, result }`。 |
| Evidence record | `result.evidence[index]` 中的 Runtime 原始 record。 |
| Record locator | 当前 Query output 中的 `result.evidence[index]`。 |
| Record correlationId | Evidence record 自己的 `correlationId`，表示其命令或业务调用关联 ID；不是 query identity。 |
| Candidate | 满足当前 Signal 固定条件和 `record_match` 的有效 Evidence record。 |

## Inputs

Required：

- 同一次调用的 Query input 和 Query output；
- `signal-rbt-evidence` contract；
- 待验证的 Signal expectation；
- `signal_ref` 指向的 Signal contract。

Optional：

- 与 record correlationId 对应的命令或调用事实；只用于追踪来源，不参与基础 record 有效性判断。

Missing：

- 缺少成功 Query output、`result.evidence`、expectation 或 Signal contract 时，受影响比较为 `unresolved`；不得从 campaign metadata 或自然语言说明重建 record。

Confirmation：

- Query input 的 `command` 为 `behavior.campaign.query`，且 `payload.includeEvidence` 为 `true`；
- Query output 的 `status` 为 `completed`、`command` 相同，`result.evidence` 是数组；
- expectation 的 `signal_ref`、`expected_presence`、`record_match` 和 `expected_values` 符合对应 Signal contract。

## Validation Boundary

本 Via 只拥有以下检查：

- 按 `signal-rbt-evidence` 校验每条原始 record 的字段、类型和空值语义；
- 在原始 record 上应用 `signal_ref` 声明的固定条件和 `record_match`；
- 对基础 Evidence 顶层字段执行 Signal 已经声明的 `match` / `not_match` 条件；
- 保留全部 candidates、逐字段比较和 Record locators；
- 按 `expected_presence` 形成基础 `match | not_match | unresolved`。

本 Via不拥有：

- kind-specific 字段的业务解释；
- State Snapshot 的 capture declaration、`source_match`、`projection_fields` 或 `data.*` 比较；
- 多条 Signal 的顺序综合或 BDD 结论。

存在更具体 Via 时，本 Via 输出有效 records、candidates 和基础比较事实，再由具体 Via 完成该 Signal 的专属比较。

## Locate Evidence

```text
Query input/output
  -> result.evidence[]
  -> 校验 signal-rbt-evidence interface
  -> 应用 signal_ref 固定条件和 record_match
  -> 保留原始 record 与 result.evidence[index] locator
```

规则：

- 所有已声明条件必须同时匹配。
- 只使用 `signal_ref` 实际定义或继承的字段；不要求没有声明的字段参与候选筛选。
- `result.evidence[index]` 是 locator，不能写入 record 的 `sequence`。
- record correlationId 原样解释为命令或业务调用关联 ID；只有命中相同 ID 的 Runtime 命令事实时，才能进一步确认它对应某条命令。
- 零个 candidates 记录为定位事实，不直接等于最终 `not_match`。
- 多个 candidates 全部保留；Signal contract 没有唯一性要求时，不产生 `ambiguous` 状态，也不擅自选择最后一条。
- 不对 ID 做大小写转换、前缀补全、模糊匹配或文本推断。

## Validate Expectation

1. 对每个 candidate，只比较当前层负责且已在 `expected_values` 声明的字段。
2. 字段满足 `match` 条件时记为字段 match；满足 `not_match` 条件时记为字段 not-match。
3. 字段缺失、无法读取或两个条件都不能确定时，该 candidate 为 unresolved。
4. 一个 candidate 的当前层全部比较字段均满足时，它是完整匹配 candidate。
5. 保留每个 candidate 的 expected、actual、comparison 和 Record locator，不只记录布尔结论。

最终基础结果：

| expected_presence | 完整匹配 candidates | 结果 |
| --- | --- | --- |
| `present` | 至少一条 | `match`；保留全部完整匹配项。 |
| `present` | 零条，且 Query 完整、所有相关 records 均可判断 | `not_match`。 |
| `absent` | 零条，且 Query 完整、没有会影响结论的 unresolved candidate | `match`。 |
| `absent` | 至少一条 | `not_match`；保留全部冲突项。 |
| 任意值 | Query 不完整，或存在会影响结论的无效 record / unresolved candidate | `unresolved`。 |

没有 candidate 只是定位结果；必须结合 `expected_presence` 才能形成最终判断。

## Constraints

- 不发起或重试 JarvisBehavior 调用。
- 不解析 WebSocket、Jarvis CLI、host output 或隐藏的 Runtime result envelope。
- 不用 query input 的任何字段覆盖 Evidence record 字段。
- 不把 campaign metadata、`evidenceCount` 或 live `behavior.evidence.query` 结果当成 historical Journal record。
- 不把 Tool `status: completed` 解释为 Signal match 或 BDD 通过。
- 不在本 Via 校验 State Snapshot capture 链、projection 或业务 `data`。

## Result

返回每条 expectation 的：

- `signal_ref`；
- 基础 `match | not_match | unresolved`，或交给更具体 Via 的基础比较事实；
- 每个原始 Evidence record 及其 `result.evidence[index]` locator；
- 全部 candidates 和完整匹配项；
- expected/actual 比较明细；
- unresolved 原因或限制。

## Exit

- 全部目标 expectation 已形成可定位比较结果；或
- 已明确记录缺失、无效或不可验证边界，不继续补造事实。

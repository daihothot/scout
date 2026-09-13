---
assetKind: scout.skill
name: signal-rbt-state-snapshot-via-rbt-behavior
description: 从 RBT 执行历史和 campaign query 结果中定位 State Snapshot，并验证 capture 声明、字段投影和预期值。
id: signal-rbt-state-snapshot-via-rbt-behavior
version: 0.2.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, unity, rbt, state-snapshot, evidence-source, dynamic-tool, behavioral]
devices: [any]
dependencies:
  skills:
    required: [signal-rbt-state-snapshot-by-rbt-evidence, signal-rbt-evidence-via-rbt-behavior]
summary: 用实际 activation、capture 和 Campaign Journal facts 验证 State Snapshot expectation。
---

# RBT State Snapshot Via RBT Behavior

当当前 `<role>` 已取得一次 RBT execute-file 的执行历史和对应 campaign query 结果，需要定位 State Snapshot 并与 expectation 比较时，使用本技能。

本技能只负责 State Snapshot 特有的 capture declaration、字段投影和 `data.*` 比较。基础 Evidence record、candidate 和 presence 由 `signal-rbt-evidence-via-rbt-behavior` 负责；具体业务字段由对应 State Snapshot Signal 解释。

## Terms

| term | meaning |
| --- | --- |
| Activation fact | 执行历史中 `status: completed` 的 `behavior.scenario.activate` command。 |
| Capture declaration | Activation fact 的 `payload.evidenceCapture.captures[]` 中的一项。 |
| Capture fact | 执行历史中 `status: completed` 的 `behavior.evidence.capture` command。 |
| Snapshot record | campaign query 的 `result.evidence[index]` 中 `kind: state_snapshot` 的原始 record。 |
| Expectation | 由具体 State Snapshot Signal 声明的预期。 |

## Inputs

Required：

- 一条 State Snapshot expectation。
- `signal-rbt-evidence-via-rbt-behavior` 形成的有效 records、candidates 和基础比较事实；
- 当前 expectation 对应的执行历史 ref、Activation fact、Capture declaration 和 Capture fact。

Optional：

- 不存在 State Snapshot expectation 时不使用本 Via，也不要求执行中出现 `behavior.evidence.capture`。

Missing：

- 当前 State Snapshot expectation 缺少已完成的 Activation fact、Capture declaration、Capture fact 或基础 Evidence 比较时，该 `SR-*` 为 `unresolved`；不得从 execute-file、Agent 转述或 live query 补造实际执行事实。
- 缺少 capture 只影响要求 State Snapshot observation 的 expectation，不阻塞没有 State Snapshot expectation 的其它执行或 Signal。

Confirmation：

- 执行历史的 `executeFileRef` 指向当前 execute-file；
- Activation fact 和 Capture fact 的 command status 均为 `completed`；
- Activation fact、Capture declaration、Capture fact 和 Snapshot record 的 campaign、scenario、source、capture identity 能组成同一条链；
- expectation 使用最具体的 State Snapshot Signal。

## Locate Snapshot

```text
Activation fact
  -> Capture declaration
  -> Capture fact
  -> campaign query result.evidence[]
  -> Snapshot record
```

1. 在 Activation fact 中按 `captureId` 精确定位唯一 Capture declaration。
2. 确认 Capture fact 的 `campaignId` 和 `captureId` 指向当前 campaign 与 declaration。
3. 从基础 Via candidates 中保留 `kind: state_snapshot`，且 `sourceId`、`captureId` 及其它已声明 `record_match` 字段全部匹配的 Snapshot records。
4. 保留 execution history command locator 和每条 `result.evidence[index]` locator。

Activation 只表示 capture 已声明；Capture fact 只表示采集命令已完成。二者都不能代替 Snapshot record。没有已完成 Capture fact 时，空 Journal 不能证明 `expected_presence: absent`。

## Validate Capture Declaration

将 expectation 与 Capture declaration 的实际值分别比较：

| expectation | actual declaration |
| --- | --- |
| `record_match.sourceId` | `sourceId` |
| `record_match.captureId` | `captureId` |
| Signal 固定条件 `kind: state_snapshot` | `kind` |
| `source_match` | `match` |
| `projection_fields` | `fields` |

- 已声明的字段、operator 和值必须一致；object key 和 fields 顺序不参与比较。
- `source_match: none` 要求 declaration 的 `match` 缺失或为空 object。
- `projection_fields: none` 要求 declaration 的 `fields` 缺失或为空数组；不表示 snapshot `data` 必须为空。
- 同时存在 `match` 和 `fields` 时，`fields` 必须包含 match 使用的全部字段；否则该执行声明无效。

## Validate Snapshot Values

1. 只对 State Snapshot candidates 校验 declaration、projection 和具体 Signal 定义的 `data.*` expected values。
2. `projection_fields` 非空时，Snapshot record 的 `data` 不得含声明外字段；每个参与判断的 `data.<field>` 必须包含在 projection 中。
3. `projection_fields` 为 `none` 时，只比较 expectation 的 `expected_values`，不限制其它实际字段。
4. 每个 expected value 按具体 Signal 声明的 `match` / `not_match` 条件比较，不从其它 record 补齐字段。
5. 多条 Snapshot candidates 全部保留；至少一条完整满足时即可支持 `expected_presence: present`，不得默认选择最后一条。
6. 保留 expected、actual、comparison 和原始 locator。

最终结果：

| condition | result |
| --- | --- |
| capture 链完整，且基础 presence、declaration、projection 和 `data.*` 均满足 | `match`。 |
| capture 链完整、事实可比较，但 declaration、projection、presence 或任一 `data.*` 明确不满足 | `not_match`。 |
| capture 链缺失或失败、基础 Evidence 无效，或比较规则不可执行 | `unresolved`。 |

`expected_presence: absent` 仍使用基础 Via 的 presence 规则，但只有在 capture 链完整、查询结果完整时，零条匹配 Snapshot record 才能形成 `match`。

## Constraints

- 不发起或重试 Dynamic Tool 调用。
- 不要求或解析隐藏的 WebSocket、schema、request envelope、endpoint 或 host command。
- 不用 execute-file 中的计划命令代替 Runtime execution history 中的实际 command facts。
- 不用 live `behavior.evidence.query` 结果代替 Campaign Journal Snapshot record。
- 不把 capture 成功、非空 `data` 或 Tool `status: completed` 单独解释为 Signal match 或 BDD 通过。
- 不要求不包含 State Snapshot expectation 的执行声明或调用 `behavior.evidence.capture`。

## Result

返回：

- `signal_ref` 和 `match | not_match | unresolved`；
- Activation、Capture 与 Snapshot locators；
- declaration、projection 和 expected-values 的逐项 expected/actual 比较；
- unresolved 原因或限制。

## Exit

- 当前 expectation 已形成完整可定位的比较结果；或
- 已明确记录缺失、无效或不可验证边界，不继续补造事实。

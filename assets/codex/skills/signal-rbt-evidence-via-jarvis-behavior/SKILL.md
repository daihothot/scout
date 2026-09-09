---
assetKind: scout.skill
name: signal-rbt-evidence-via-jarvis-behavior
description: 从已有 Jarvis Behavior campaign query 中取得 RBT Evidence Signal，并与 Signal expectation 比较时使用。
id: signal-rbt-evidence-via-jarvis-behavior
version: 0.1.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, unity, rbt, campaign-journal, jarvis, behavioral]
devices: [any]
dependencies:
  skills:
    required: [signal-rbt-evidence, tool-jarvis-behavior]
summary: 从 Jarvis Behavior Campaign Journal query 定位原始 RBT Evidence record 并验证 Signal expectation。
---

# RBT Evidence Via Jarvis Behavior Signal

## Terms

- `<role>`：当前读取和使用本 Signal 的实际 Scout role。
- `query request`：顶层 `type` 为 `behavior.campaign.query` 的完整 Jarvis Behavior 请求。
- `query result`：与 query request 属于同一次调用的完整 `behavior.command.result`。
- `query correlationId`：query request 与 query result 顶层用于配对本次查询的 `correlationId`。
- `record correlationId`：`payload.evidence[index].correlationId`，表示历史 record 保存的命令或调用关联 ID。
- `<command-result-ref>`：能够重新打开完整 query result 的实际来源引用。
- `source position`：由 `<command-result-ref>` 和 record 在 query result 中的 JSON Pointer 组成的原始位置。
- `expectation`：按 `signal-rbt-evidence` 及具体 derived Signal 声明的一条预期 Signal。
- `candidate`：同时满足 expectation `signal_ref` 固定条件和 `record_match` 的实际 record。

当 <role> 已有 Jarvis Behavior 命令请求、返回值和来源引用，需要从中取得 `signal-rbt-evidence` 时使用本技能。

本技能负责定位 query request/result、取得原始 `payload.evidence[index]`，并使用 Signal Interface 定义的 expectation 对实际 records 做逐字段比较。通过 interface 检查的 Signal 仍是 RBT Runtime 原样返回的 record；source position 和比较事实保存在 record 外。命令调用、请求参数、session、transport、重试和命令结果 contract 属于 `tool-jarvis-behavior` 及其 required Tool Skill。

## Skill Type

- type: signal
- layout: compact
- contract role: implementation
- note: 本技能通过 Jarvis Behavior Campaign Journal query 实现 signal-rbt-evidence contract。

## Core Use

使用本技能处理：

- 在已有 Jarvis Behavior 命令事实中定位 query request/result pair。
- 确认 query request 实际要求返回 historical evidence。
- 从 query result 的 `payload.evidence[]` 定位并验证每条 RuntimeEvidence record。
- 在 record 外单独保留完整 result ref 和 source position。
- 按 expectation 的 `signal_ref` 和 `record_match` 定位 candidates，并对 `expected_values` 中声明的值形成比较事实。
- 分开记录预期 Signal 缺失、值不匹配、无法判断和多条匹配记录。

职责边界：本 Via 只负责从已有命令事实定位原始 record，并按 `signal_ref` 的 Interface 比较 expectation；命令调用、字段语义和业务结论由对应 Tool / Signal / Domain Skill 负责。

## Implementation Contract

implementation mechanism 是 `jarvis-behavior`，被实现 contract 是 `signal-rbt-evidence`。

本 implementation 的输入不是待执行命令，而是已经存在的命令调用事实。一次候选调用必须同时具备：

- 完整 Jarvis Behavior request；
- 与该 request 配对的完整 command result；
- 能够重新打开该完整 command result 的稳定 ref。

请求和结果是否符合命令 contract，由 `tool-jarvis-behavior` 判断。本 implementation 不修改请求，也不根据期望结果选择另一条查询。

## Inputs

### I-001: Jarvis Behavior Command Facts
---

描述：

- 一组可定位的 Jarvis Behavior request/result pairs；每一组保留完整 request、完整 result 和实际 result ref。

Required：完整 `behavior.campaign.query` request/result pair、稳定 result ref，以及可读取的 Signal expectation。

Optional：额外的 command / invocation 关联事实，用于解释 record 的 `correlationId`；不替代 query pair。

Missing：缺少 pair、result ref、原始 `payload.evidence[]` 或 expectation Interface 时，受影响结果为 blocked / unresolved，不补造 record。

Confirmation：确认 request/result 属于同一 query 调用、结果可重放，且 expectation 字段均由 `signal_ref` 指向的 Interface 定义。

注意事项：

- 只有 request、result 和 ref 都属于同一个实际命令调用时，才能进入定位。
- <role> 摘要、截断预览、只含 `payload.evidence` 的摘录或手工复制的字段表不能替代完整 query result。

## Locate the Command Result

按以下事实定位，不按文件顺序或结果内容猜测：

1. 选择顶层 `type` 精确等于 `behavior.campaign.query` 的 query request。
2. 确认 request 的 `payload.includeEvidence` 精确等于 `true`。
3. 读取 request 顶层的 query correlationId。
4. 在同一次命令调用的完整 result 中确认顶层 `correlationId` 与 request 完全相等。
5. 确认 result 顶层 `type: behavior.command.result`、`version: 1`、`status: ok` 和 `code: ok`。
6. 确认 result 顶层 `payload` 是 object，`payload.campaigns` 和 `payload.evidence` 都是 array。

query correlationId 只用于配对本次查询。record correlationId 属于历史 record，表示 record 保存的命令或调用关联 ID；它不保证一定对应命令。两者可以不同，不能相互覆盖。

Jarvis CLI 的 `[RESULT]` 内容已经是 operation result；本 implementation 从其中的 Behavior command result 开始定位，不把 JSON-RPC transport 外层当作 `payload`。

定位结构：

```text
<command-result-ref>
└── behavior.command.result
    ├── correlationId        # 与 query request 配对
    ├── status
    ├── code
    └── payload
        ├── campaigns[]      # campaign metadata；不是 RBT Evidence interface
        └── evidence[]       # RuntimeEvidence records
            └── <index>      # 一条原始 RuntimeEvidence record
```

同一批 facts 中存在多条可用 query request/result pairs 时，每条独立定位。<role> 没有指定目标时，返回每个候选的 query correlationId 和 result ref，不替 <role> 选择。

## Validate One Runtime Record

对 `payload.evidence[index]` 的每个元素独立检查：

| field | required JSON type |
| --- | --- |
| `campaignId` | string |
| `scenarioId` | string |
| `correlationId` | string |
| `traceId` | string |
| `parentTraceId` | string |
| `sequence` | integer |
| `timestamp` | ISO 8601 string |
| `kind` | string |
| `sourceId` | string |
| `captureId` | string |
| `id` | string |
| `variantId` | string |
| `result` | string |
| `fallbackReason` | string |
| `error` | string |
| `data` | object |

record 可以形成 interface 的条件：

- record 本身是 JSON object，而不是 string、array、null 或截断文本；
- 表中每个字段都实际存在并且类型正确；
- `sequence` 是 JSON integer，不接受数组下标或字符串数字；
- `timestamp` 可以按 ISO 8601 解析，但必须保留原始字符串；
- `kind` 是 Runtime schema 的合法值之一：`behavior_trace`、`analytics_event`、`structured_log`、`response_payload`、`state_snapshot`、`websocket_response` 或 `error`；
- `data` 是 object，即使它为空；
- result ref 能重新打开包含该 record 的完整 query result。

空字符串是 RBT Runtime 对可选 string 字段的正式返回值。字段缺失、`null` 或类型错误不是空字符串。record 包含表外字段时也必须原样保留。

## Result

每条通过检查的 `payload.evidence[index]` 原始 object 就是一条 `signal-rbt-evidence` interface：

- 字段名、字段值和表外字段全部保持原样；
- 不创建新的 record，也不向 record 添加 Signal identity 或来源字段；
- source position 在 record 外单独记录：

```text
<command-result-ref>#/payload/evidence/<index>
```

- `index` 只定位 record，不替代 `sequence`；
- 保留 `payload.evidence[]` 的实际数组顺序，但不据此重排或补齐 `sequence`；
- 本 implementation 不解释 kind-specific 字段。
- `payload.evidence: []` 表示该 query command 返回零条 RuntimeEvidence，不生成伪 Signal。
- request 已声明 `includeEvidence: true` 但 result 没有 `payload.evidence` 时，不能从 campaign metadata、其它命令或 <role> 叙述重建 records。
- 一批 records 中存在格式错误时，格式正确的 records 仍可单独形成 interface；同时报告错误 index 和字段，并说明该 query result 不是完整可解析的 Journal 集合。
- record 通过验证只表示取得 interface；具体 `kind` 由匹配的 derived Signal 解释。

## Compare A Signal Expectation

比较前必须已完整读取 expectation `signal_ref` 指向的 Interface。该 Interface 负责说明 Signal 固定条件、可用定位字段、可预期字段和字段值语义。

对每条 expectation：

1. 先在同一批已验证 records 中应用 `signal_ref` 声明的固定条件，例如 `kind: behavior_trace`。
2. 再应用 `record_match`。字段必须存在，实际值必须满足该 Interface 声明的定位语义；通过的 records 成为 candidates。
3. 对每个 candidate，只计算 `expected_values` 中已声明的字段。保留该字段的实际值、预期值、match 条件、not-match 条件和 source position。`expected_values: none` 时，通过前两步的 candidate 就是完整匹配 candidate。
4. 一个 candidate 的所有已声明字段都满足 match 条件时，该 candidate 是完整匹配。任一字段满足 not-match 条件时，该 candidate 不匹配。字段缺失、无法读取或两个条件都不能确定时，该 candidate 是 `unresolved`。
5. 保留全部 candidates 和全部完整匹配项；多条匹配时不擅自选“最后一条”。

expectation 的比较结果：

| expected_presence | 完整匹配 candidates | 结果 |
| --- | --- | --- |
| `present` | 至少一条 | `match`；保留所有匹配 source positions。 |
| `present` | 零条，且完整 Journal 可读、所有 candidates 都已明确不匹配 | `not_match`。 |
| `absent` | 零条，且完整 Journal 可读、没有 unresolved candidate | `match`。 |
| `absent` | 至少一条 | `not_match`；保留所有冲突 source positions。 |
| 任意值 | Journal 不完整、来源不可重放，或存在会影响结果的 unresolved candidate | `unresolved`。 |

该结果只回答“实际 Signal 是否符合这条 expectation”。它不回答 BDD 是否通过，也不决定多条 Signal 之间的业务顺序。

## Evidence Rules (Enforcement)

- ER-001：每条 Signal 必须来自可配对的 `behavior.campaign.query` request/result，并保留完整 result ref。
- ER-002：request/result 的顶层 `correlationId` 必须相等；不得使用 evidence record 自身的 `correlationId` 代替 query 配对。
- ER-003：每条 interface 的全部字段和值必须是同一个 `payload.evidence[index]` 原始 object，不得修改。
- ER-004：source position 必须与 record 分开保留，不得写入 interface。
- ER-005：expectation 比较必须使用 `signal_ref` 指向的 Interface；只比较已声明字段，并保留每个 candidate 的 source position。

## Failure Rules (Enforcement)

- FR-001：`tool-jarvis-behavior` 已将命令判定为失败，或 result 的 `type`、`version`、`correlationId`、`status`、`payload` 无法通过当前 command contract 时，不从该 result 生成 RBT Evidence Signal。
- FR-002：单条 record 缺少 interface 字段、字段类型错误、`timestamp` 不能解析、`kind` 未知或 source position 不可重放时，不形成该条 interface；报告具体 index 和字段。
- FR-003：expectation 引用的 Signal Interface 不可读、字段未由该 Interface 定义或比较条件不能执行时，结果是 `unresolved`，不得自行重写 expectation。

## Blocking Rules (Enforcement)

- BR-001：没有完整 request/result pair 或稳定 result ref 时，阻塞从受影响命令调用形成 interface。
- BR-002：存在多个可用 query request/result pairs 而 <role> 无法确定目标时，阻塞候选之间的选择，但保留每个候选的定位事实。

## Prohibited Rules (Enforcement)

- PR-001：禁止在本 implementation 中选择命令参数、改写 request、发起调用或复制 Tool Skill 的调用方法。
- PR-002：禁止使用其它命令结果、campaign metadata、<role> 总结或 Scout command log 补造 `payload.evidence[]`。
- PR-003：禁止重命名、删减、补写或包装 RuntimeEvidence record。
- PR-004：禁止把 query correlationId 写入历史 record，或把数组 index 写入 `sequence`。
- PR-005：禁止解释具体 `kind`、业务结果或 BDD 结论。
- PR-006：禁止将未声明字段、非唯一 candidate、查询成功或非空 Journal 自动改写为 Signal match。

## Checklist

- query request 的 `type` 是 `behavior.campaign.query`，`payload.includeEvidence` 是 `true`，query request/result pair 和 result ref 均可定位。
- query correlationId 只用于配对查询；record correlationId 原样保留为命令或调用关联 ID。
- 每条 interface 就是同一个 `payload.evidence[index]` 原始 object，没有字段映射或包装。
- source position 与 interface 分开保留，数组 index 没有替代 `sequence`。
- 空数组、字段缺失、单条格式错误、命令失败和多候选没有混为同一结果。
- 命令调用和参数 contract 留在 Tool Skill，具体 `kind` 留在 derived Signal。
- expectation 逐条保留 candidates、字段比较事实和 source positions，且只形成 Signal 层的 `match / not_match / unresolved`。

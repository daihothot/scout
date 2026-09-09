---
assetKind: scout.skill
name: signal-rbt-state-snapshot-via-jarvis-behavior
description: 从 Jarvis Behavior capture 声明、capture 结果和 Campaign Journal 中定位 RBT State Snapshot，并验证筛选、字段投影和预期值时使用。
id: signal-rbt-state-snapshot-via-jarvis-behavior
version: 0.1.0
type: signal
family: [signal, local, unity, rbt, general]
tags: [signal, unity, rbt, state-snapshot, evidence-source, jarvis, behavioral]
devices: [any]
dependencies:
  skills:
    required: [signal-rbt-state-snapshot-by-rbt-evidence, signal-rbt-evidence-via-jarvis-behavior]
summary: 通过 Jarvis Behavior 定位 State Snapshot，并验证 EvidenceSource 筛选、投影和 Signal 预期。
---

# RBT State Snapshot Via Jarvis Behavior Signal

## Terms

- `<role>`：当前读取和使用本 Signal 的实际 Scout role。
- `source descriptor`：`behavior.evidence.sources` 返回的某个 EvidenceSource 实际 descriptor。
- `capture declaration`：`behavior.scenario.activate` 请求中 `payload.evidenceCapture.captures[]` 的一项。
- `capture command`：已完成的 `behavior.evidence.capture` 请求与结果。
- `snapshot record`：Campaign Journal 中 `kind: state_snapshot` 的原始 RuntimeEvidence record。
- `expectation`：按 `signal-rbt-state-snapshot-by-rbt-evidence` 或更具体业务 State Snapshot Signal 声明的预期。

当 <role> 需要从已有 Jarvis Behavior 命令事实中确认一条 State Snapshot 是如何被声明、采集和投影的，并将它与 expectation 比较时使用本技能。

本技能只负责 State Snapshot 特有的定位和验证：source 是否存在、capture 是否按预期声明、capture 命令是否实际发生、Journal 中是否存在对应 snapshot、字段投影和预期值是否匹配。命令怎么调用、参数是什么、结果是否成功、如何重试和何时退出由 `tool-jarvis-behavior` 定义。

## Skill Type

- type: signal
- layout: compact
- contract role: implementation
- note: 本技能通过 Jarvis Behavior 实现 State Snapshot 的定位、投影和 expectation 验证。

## Core Use

使用本技能处理：

- 从 source descriptor 确认 `sourceId`、`kind`、可筛选字段、operator 和可投影字段。
- 从 scenario activation 定位 capture declaration 中的 `captureId`、`sourceId`、`kind`、`match`、`fields` 和 `limit`。
- 定位实际 capture command，并将它与 Journal 中的 snapshot records 关联。
- 验证 expectation 声明的 source 筛选、字段投影和具体 `data` 值。

职责边界：本 Via 只负责 State Snapshot 的定位、projection 验证和 expectation 比较；命令调用、具体业务字段和最终业务结论由对应 Tool / Signal / Domain Skill 负责。

## Inputs

### I-001: State Snapshot Command Facts
---

描述：

- 一组完整且可定位的 source descriptor、scenario activation、capture 和 Campaign Journal query request/result facts。

Required：能配对并重放上述命令事实，以及一条 State Snapshot expectation。

Optional：用于缩小目标的 campaign、scenario、source 和 capture 关联事实。

Missing：缺少任一必要 request/result pair、稳定 ref 或 expectation 字段时，受影响比较为 blocked / unresolved，不补造 snapshot。

Confirmation：确认 source descriptor、declaration、capture result 和 Journal record 能关联到同一实际 source / capture；不要求固定的命令时序。

注意事项：

- 每类命令事实必须按 `tool-jarvis-behavior` 的 contract 已经成功配对。source descriptor 只需能够定位同一目标 Runtime registry 事实；不能用不相关 source 替换。
- 只有返回值摘要、Agent 转述或只含 `data` 的文本不能替代完整事实。

### I-002: State Snapshot Expectation
---

描述：

- 一条符合 State Snapshot Interface 的 expectation，包含 `signal_ref`、`expected_presence`、`record_match`、`source_match`、`projection_fields` 和 `expected_values`。

Required：`signal_ref`、`expected_presence`、`record_match`、`source_match`、`projection_fields` 和 `expected_values`。

Optional：用于缩小候选的 campaign、scenario、sequence 或其它关联字段。

Missing：任一 required expectation 字段缺失时，不能执行完整比较；保持 unresolved，不自行补写。

Confirmation：确认字段由 `signal-rbt-state-snapshot-by-rbt-evidence` 或更具体的 State Snapshot Signal 定义，并与实际 declaration 对齐。

## Locate The Snapshot

按以下事实关联，不按文件顺序或相似名称猜测：

1. 在 source descriptor result 中找到 `sourceId` 精确等于 `record_match.sourceId` 的 source，并确认它的 `kind` 是 `state_snapshot`。
2. 在实际 scenario activation request 中找到 `captureId` 精确等于 `record_match.captureId` 的 capture declaration。
3. 确认 declaration 的 `sourceId` 和 source descriptor 一致，`kind` 是 `state_snapshot`，并保留其 `match`、`fields` 和 `limit` 实际值。
4. 找到 `payload.campaignId` 和 `payload.captureId` 指向当前 campaign 与 capture declaration 的 capture command。
5. 使用 `signal-rbt-evidence-via-jarvis-behavior` 从 Campaign Journal query 定位 `kind`、`sourceId`、`captureId`、`campaignId` 和 `scenarioId` 一致的 snapshot records。
6. 保留 declaration ref、capture command ref、Journal record source position 和每条 record 的实际 `sequence`。

`behavior.scenario.activate` 只保存 capture declaration。没有实际 capture command 时，不能声称 snapshot 已经生成。

## Verify Source Match

对比 expectation `source_match` 和 capture declaration `match`：

- 字段名、operator 和值必须逐项一致；顺序不参与比较。
- 每个字段必须存在于 source descriptor `queryCapabilities.fields`，字段必须可筛选，operator 必须是该字段或 source 声明支持的实际 operator。
- expectation 声明 `none` 时，declaration `match` 必须为空。
- source match 完全一致只表示按预期进行了筛选；不表示 source 一定返回 record。

## Verify Field Projection

1. 将 expectation `projection_fields` 与 capture declaration `fields` 按字段集合比较，不比较顺序。
2. 对每个投影字段，确认 source descriptor 允许选择该字段。
3. `projection_fields` 非空时，每条 snapshot `data` 不得包含声明之外的字段。
4. 每个出现在 `expected_values` 的 `data.<field>` 都必须被 `projection_fields` 声明。
5. 实际 snapshot 中缺少一个参与判断的投影字段时，该 record 对 expectation 是 `not_match`；不从其它 record 补齐。

`projection_fields` 为空只表示 capture declaration 没有指定字段白名单；实际返回的全部 `data` 字段都可以声明为 `expected_values`。只有在 projection 非空时，参与判断的 `data.<field>` 才必须显式包含在投影列表中；空 projection 不验证“只包含某些字段”。

## Verify Expected Values

- 使用 expectation `signal_ref` 指向的具体 State Snapshot Interface 解释 `data.<field>` 的类型、空值、match 和 not-match 语义。
- 只比较 `expected_values` 中已声明的字段；保留实际值、预期值、比较条件和 record source position。
- 字段存在且满足 match 条件时为字段 match；字段缺失或满足 not-match 条件时为字段 not-match。
- 来源不完整、record 不可重放、字段语义不可读或比较条件无法执行时为 unresolved。
- 最终 expectation 结果使用 `signal-rbt-evidence-via-jarvis-behavior` 的 `expected_presence` 规则，并额外要求 source match 与 projection 都已匹配。

## Result

本 Via 产生的是 Signal 层比较事实：

- source descriptor ref、capture declaration ref、capture command ref 和 Journal record source positions；
- source match 比较结果；
- projection fields 比较结果；
- 每个 `expected_values` 字段的实际值、预期值和比较结果；
- 整条 expectation 的 `match / not_match / unresolved`。

原始 snapshot record 保持不变。本结果不包含 BDD pass / fail，也不对多个 SR 或 JR 做业务综合。

## Evidence Rules (Enforcement)

- ER-001：State Snapshot 必须由同一 campaign 和 scenario 中可定位的 capture declaration、capture command 和 Campaign Journal record 共同支持。
- ER-002：source match、projection fields 和 expected values 必须分别验证，不得用其中一项替代另一项。
- ER-003：每个实际字段值必须来自同一原始 snapshot record，并保留 source position。

## Failure Rules (Enforcement)

- FR-001：source descriptor、capture declaration 或 capture command 不匹配 expectation 时，保留具体差异，不得改写 expectation 或选择相似 source / capture。
- FR-002：完整 Journal 可读，capture 已成功且实际字段缺失时，保留该字段 not-match；不补默认值。

## Blocking Rules (Enforcement)

- BR-001：无法将 source descriptor、declaration、capture command 和 Journal record 关联到同一 campaign / scenario / capture 时，阻塞该 expectation 的完整比较。

## Prohibited Rules (Enforcement)

- PR-001：禁止在本 Via 中选择命令、填写请求、执行调用或复制 Tool Skill 的重试和退出规则。
- PR-002：禁止使用 live query result、Agent 摘要或其它 campaign 的 snapshot 补造当前 Journal record。
- PR-003：禁止把 capture command success、非空 `data` 或 source match 成功单独解释为整条 Signal expectation 已匹配。

## Checklist

- source descriptor、capture declaration、capture command 和 Journal record 指向同一 source / capture / campaign / scenario。
- source match、projection fields 和 expected values 已分别验证。
- 每个参与判断的 `data.<field>` 都由具体 Signal Interface 解释，并保留实际 source position。
- 没有使用 live source 结果替代 campaign snapshot，也没有形成 BDD 结论。

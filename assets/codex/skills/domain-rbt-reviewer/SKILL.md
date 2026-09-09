---
assetKind: scout.skill
name: domain-rbt-reviewer
description: Scout Reviewer 在 RBT Domain 中独立读取 Execution Pack 和 Runtime campaign、evidence journal，并形成审查结论时使用。
id: domain-rbt-reviewer
version: 0.2.0
type: domain
domain: rbt
phase: [review]
family: [rbt, workflow]
tags: [scout, rbt, bdd, review, evidence, workflow]
devices: [any]
dependencies:
  skills:
    required: [domain-rbt-execution-pack, signal-rbt-evidence-via-jarvis-behavior, signal-rbt-state-snapshot-via-jarvis-behavior, tool-jarvis-behavior, family:tool.scout.dynamic.general.**, family:tool.scout.dynamic.worker.**]
    optional: [family:signal.local.unity.rbt.**]
summary: 独立查询 Runtime evidence，并判断其是否覆盖 BDD。
---

# Domain RBT Reviewer

当 Reviewer 在 Runtime Behavioral Test（RBT）Domain 中收到 Executor 正式交付，需要独立读取 Execution Pack、查询 Runtime campaign 和 evidence，并判断是否覆盖 BDD 时使用本技能。后续 `RBT` 均表示 Runtime Behavioral Test。

本技能拥有独立审查过程和本轮 RBT 结论；Behavioral 查询命令的调用 contract 由 `tool-jarvis-behavior` 所有。

## Skill Type

- type: domain
- layout: workflow
- note: 本技能拥有 Runtime evidence 的独立业务判断，不拥有执行计划、Runtime 行为触发或 cleanup。

## Core Use

使用本技能处理：

- 核对同一 BDD、Execution Pack，以及单独提供的 Runtime campaign identity。
- 使用与 Executor 不同的 WebSocket session 查询 Runtime campaign historical journal，并从同一次执行的 Runtime campaign artifact 取得 State Snapshot 所需的 EvidenceSource descriptor 与 capture 事实。
- 对 Execution Pack 中每个 `SR-*`，使用它的 Signal Interface 解释预期，使用对应 Via 与实际 Signal 比较。
- 将 Signal 比较事实与 BDD 前置状态、触发动作和预期行为逐项对应。
- 形成与 Runtime evidence 一致的独立结论。
- 写入正式 Reviewer artifact 并提交 handoff。
- 区分完整的否定结论、证据不足结论和只需修正 Pack 的 correction request。

不使用本技能处理：

- 激活 scenario、调用 trigger、修改 Executor 计划或重新执行测试来验真。
- 停用 scenario、停止 campaign，或补做 Executor 未完成的 cleanup。
- 复用、接管或断开 Executor 的 WebSocket session。
- 修改 Executor artifact、Runtime evidence journal 或 Guru Knowledge。

## RBT Review Model

- Reviewer 只读 Execution Pack；Runtime campaign artifact 和 campaign identity 由独立的 Runtime 输入提供，不通过 Pack 传递。
- Reviewer 使用自己的 WebSocket session。Runtime 保存的 campaign historical journal 是当次执行的 Signal 来源；Executor 的自然语言总结不能替代。
- `behavior.campaign.query` 用于 campaign metadata 和 historical journal。Runtime campaign artifact 中 Executor 预检的 `behavior.evidence.sources` 结果、activation request 和 capture command 事实用于定位 snapshot 的 source capability、声明和采集链，不代替实际 snapshot record。Reviewer 不用执行后重新查询的 registry 状态替换执行时事实。
- 每个 `SR-*` 只按 `signal_ref` 指向的 Interface 和 Via 处理。Interface 定义预期怎么解释，Via 定义怎么定位和形成 `match / not_match / unresolved`，本 Domain Skill 只综合这些事实形成 BDD 结论。
- Reviewer 不 activate、不 invoke，也不为了得到更好的证据再次执行测试。
- `match` 和明确的 `not_match` 都是完整审查结果，正常完成 review。`not_match` 不表示 Executor 应重新执行。
- 只有不启动平台、不调用 Behavioral command、不取得新 Runtime evidence 即可修复的 Pack 遗漏、引用错误或笔误，才能形成 correction request。
- 如果缺口需要新 platform run、新 trigger、新 capture 或其它新执行事实，本轮形成 evidence insufficient / invalid execution 结论，不要求重跑。
- Scenario 和 campaign lifecycle 由 Executor 推进、由 Runtime 记录。Reviewer 只读取 Runtime campaign artifact 中的 cleanup 事实，不调用 cleanup 命令。
- Execution Pack 由 `domain-rbt-execution-pack` 定义，Reviewer 只读。正式 Reviewer artifact、结论状态和 handoff 由 Review Pack Skill 定义；本技能只规定审查职责以及必须交给该 Pack 的业务事实。

## Inputs

### I-001: Review Task
---

描述：

- Coordinator 提供的 task id、唯一 BDD identity、BDD source ref，以及 Executor handoff 中的 `pack_id` 和 `pack_ref`。Runtime 另外提供本次执行的 `campaignId` 和 campaign artifact 定位。

注意事项：

- BDD 与 Executor 交付中的 BDD 不一致时停止。
- Execution Pack 缺失、不可读、BDD 不一致或 Runtime campaign identity / artifact 缺失时，不从普通消息、日志猜测或现场状态补齐。

### I-002: Runtime Review Connection
---

描述：

- 当前目标 Runtime 的 endpoint、callable schema path，以及与 Executor session identity 不同的 Reviewer session identity。

注意事项：

- Reviewer session 与 Executor session 相同、指向其它 endpoint 或被其它 writer 使用时停止。
- 独立 session 只用于本技能允许的 query 命令。

## Behavioral Tool Use

通过以下 Skill 使用 Behavioral 控制面：

```text
tool-jarvis-behavior
```

允许的审查命令：

```text
behavior.campaign.query
```

本技能决定查询范围和 BDD 证据解释；命令请求、结果信封、副作用、退出条件和重试边界遵守该 Tool Skill。

## Workflow Overview

Phase 说明：

- Phase 1：核对 BDD、Executor 交付、Runtime campaign identity 和独立 Reviewer session。
- Phase 2：查询 campaign historical journal，并对 Pack 中每个 `SR-*` 使用对应 Via 形成 Signal 比较事实。
- Phase 3：将全部 Signal 比较事实、Journal 顺序和 BDD 逐项对应，形成独立结论。
- Phase 4：写入正式审查交付并提交 handoff。

## Review Output Boundary

Reviewer 将独立结论、直接 Runtime evidence、实际检查范围、限制、冲突和阻塞交给 Review Pack Skill，由它定义正式 artifact、结论状态、refs、完整性和 handoff。Execution Pack 与 Runtime campaign artifact 是两套独立输入；cleanup 只引用 Runtime campaign artifact 中的事实。

Reviewer 不复制完整 Runtime evidence，不把 Executor cleanup success 当作 BDD 结论，也不自行定义临时交付格式。

## Phase 1: Confirm Review Boundary
---

读取 BDD source 和 Execution Pack，并取得 Runtime 单独提供的 campaign artifact。核对 BDD、endpoint、schema、campaignId、scenarioId、rootId、trigger identity 和 Pack 中的全部 `SR-*`。确认每个 `signal_ref` 及对应 Via 可读，Reviewer session 与 Executor session 不同。

Exit：

- BDD、Executor artifact refs、Runtime campaign identity / artifact 和独立 Reviewer connection 足以开始查询。

Blocked：

- BDD 不一致、正式交付缺失、campaign identity 或 artifact 无法定位、Reviewer session 不独立，或 required Tool Skill 不可用时停止。

Partial：

- 可以列出已确认输入和缺口，但不得查询不确定的 campaign、scenario 或 evidence source。

## Phase 2: Query Runtime Evidence
---

先使用 `behavior.campaign.query` 按 Runtime 单独提供的 `campaignId` 查询 campaign metadata 和 historical evidence journal。

对每个 `SR-*`：

1. 读取 `signal_ref` 指向的 Interface，确认 Pack 中的 expectation 形状和字段含义。
2. 使用对应 Via 从 historical journal 定位 actual Signal，并形成 `match / not_match / unresolved` 事实。
3. State Snapshot 另外使用 Runtime campaign artifact 中 Executor 已记录的 `behavior.evidence.sources`、activation 和 capture command 事实，由 `signal-rbt-state-snapshot-via-jarvis-behavior` 验证 source match、projection fields 和 actual values。
4. 保留每个 candidate、source position、字段差异和 unresolved 原因；不在 Via 层直接形成 BDD 结论。

Exit：

- 已取得可引用的 campaign query 结果，且每个 `SR-*` 都已形成 Signal 比较事实或明确 unresolved 原因。

Blocked：

- Runtime connection、campaign identity、Signal Interface、Via 或 State Snapshot source / capture 链无法确认时停止相关验证。

Partial：

- 某一 Signal 为 `not_match` 或 `unresolved` 时保留其它独立 Signal 的比较事实，不用其它 record 补造它。

## Phase 3: Determine Coverage
---

以 BDD source 为判断基准，分别检查：

- 前置状态是否有对应 Runtime evidence。
- 触发动作是否与 Executor 交付和 campaign journal 一致。
- 预期行为是否有可定位 evidence 支撑。
- evidence 的 scenario、campaign、source、sequence 和时间关系是否属于同一次执行。
- 是否存在与结论冲突的 Runtime evidence 或未覆盖范围。
- 每个 `SR-*` 的 Signal 比较事实是否支持、否定或无法覆盖它引用的 `E-BDD-*`。

根据直接 evidence 形成独立判断，并将判断事实交给 Review Pack Skill 映射为正式结论状态；不能把 cleanup 状态放入 coverage 结论。明确的 `not_match` 是有效否定结论，不是 workflow error。

Exit：

- 已形成明确判断，并且每个支持或否定判断都有直接 Runtime evidence 或明确缺失事实。

Blocked：

- BDD source 不可读、执行交付与查询结果无法关联，或关键查询因能力缺失无法完成时停止判断，并把阻塞事实交给 Review Pack Skill。

Partial：

- 证据可读但不足以支持或否定 BDD 时，保留证据不足事实，不将其改写为支持或否定。

## Phase 4: Submit Review
---

把本技能产生的业务事实交给 Review Pack Skill，按其 contract 写入正式审查交付并提交 handoff。`match`、`not_match`、evidence insufficient 和 invalid execution 均作为完整审查结果正常提交。

只有发现可由原 Pack 已有来源或既有 Agent 事实修正的字段遗漏、locator、引用或笔误时，才提交 correction request。必须逐项说明修改对象和已有依据，并明确禁止重新运行平台或 Runtime。

Exit：

- Review Pack 已形成正式 handoff，且独立判断与 Runtime 查询结果一致；或者已形成无需新执行事实即可处理的明确 correction request。

Blocked：

- Review Pack Skill 不可见或正式交付不可写时不得提交 handoff。Executor cleanup 未完成时如实引用该限制，不由 Reviewer 补做。

Partial：

- 允许提交 `not_match`、证据不足、执行无效或上游 cleanup 不完整的独立判断；不得把它们改写成 workflow error 或重跑请求。

## Workflow Exit Rules (Enforcement)

- XR-001：Phase 2 只能在 BDD、Execution Pack 和独立 Reviewer session 均已确认后开始。
- XR-002：只有 Phase 2 查询完成并保留实际结果后，才能形成 coverage conclusion。
- XR-003：只有 Review Pack contract 已形成与查询结果一致的正式 handoff 时，才能提交当前 Reviewer task。

## Evidence Rules (Enforcement)

- ER-001：coverage conclusion 只接受 BDD source、Execution Pack、Runtime campaign artifact、campaign historical journal 和 Via 产生的 Signal 比较事实。
- ER-002：Runtime command facts 只用于定位 scenario / capture 配置和执行关系，不能代替 Campaign Journal 中的 actual Signal；Executor summary 和 Reviewer 现场推测也不是 Runtime evidence。
- ER-003：空 evidence、缺失 evidence 和与 BDD 冲突的 evidence 必须保持各自语义，不能统一改写为失败或成功。
- ER-004：Reviewer 必须处理 Pack 中每个 `SR-*`，不得只选最终 State Snapshot 而忽略 Behavior Trace、Error 或 expected-absent Signal。

## Failure Rules (Enforcement)

- FR-001：查询失败必须按实际失败层次记录；不能据此直接形成否定 BDD 的结论。
- FR-002：Executor cleanup 失败只能作为上游限制引用，不能覆盖已经由证据形成的 conclusion。
- FR-003：明确 `not_match`、证据不足或执行无效是审查结论，不是 Reviewer task 失败。

## Blocking Rules (Enforcement)

- BR-001：无法将 Runtime evidence 唯一关联到 Executor 交付的 campaign 和 scenario 时，阻塞支持或否定 BDD 的判断。
- BR-002：Review Pack Skill 不可见时，阻塞正式 handoff，不以临时格式替代。

## Retry Rules (Enforcement)

- RR-001：query 重试严格遵守 `tool-jarvis-behavior`；不得通过重复查询、重新执行或修改条件追求预期结论。
- RR-002：Reviewer 不要求重新运行平台、campaign、Scenario、trigger 或 capture；需要这些动作才能补齐时，直接保留本轮证据不足或执行无效结论。

## Prohibited Rules (Enforcement)

- PR-001：禁止 Reviewer 调用 `behavior.campaign.start`、`behavior.scenario.activate`、`behavior.node.variants`、`behavior.trigger.invoke`、`behavior.evidence.capture`、`behavior.scenario.deactivate` 或 `behavior.campaign.stop`。
- PR-002：禁止 Reviewer 复用 Executor session，或重新执行测试来补证据。
- PR-003：禁止修改 Executor artifact、Runtime evidence 或 BDD source。
- PR-004：禁止把 Executor cleanup success、连接成功、命令 success 或非空 evidence 单独解释为 BDD 已被覆盖。
- PR-005：禁止把 `not_match` 当作 correction，或借 correction 要求 Executor 产生新的 Runtime 事实。

## Checklist

- BDD、Executor artifact、Runtime campaign identity / artifact 和 Reviewer 独立 session 已确认。
- 查询范围只服务当前 BDD，Runtime command facts、campaign journal 和 Signal 比较事实没有混淆。
- Pack 中每个 `SR-*` 都已按对应 Interface 和 Via 形成比较事实，没有遗漏 Behavior Trace、Error、State Snapshot 或 expected-absent Signal。
- 独立判断由直接 Runtime evidence 或明确缺失事实支持。
- `match`、`not_match`、evidence insufficient 和 invalid execution 均按完整审查结果提交；只有无需重跑即可修复的 Pack 问题才要求 correction。
- 没有 activate、invoke、复用 Executor session 或重新执行测试。
- 没有调用 cleanup 命令，也没有替 Executor 修复 lifecycle 状态。
- 正式 handoff 由 Review Pack Skill 形成；没有在本技能中定义 Pack schema。

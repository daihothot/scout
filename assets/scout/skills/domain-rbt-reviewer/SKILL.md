---
assetKind: scout.skill
name: domain-rbt-reviewer
description: Scout Reviewer 消费有效 JR/SR，查询同次 campaign evidence，比较声明与实际记录并交付审查结果时使用。
id: domain-rbt-reviewer
version: 0.12.0
type: domain
domain: rbt
phase: [review]
family: [rbt, workflow]
tags: [scout, rbt, bdd, review, evidence, workflow]
devices: [any]
dependencies:
  skills:
    required: [domain-rbt-review-pack, signal-rbt-evidence, signal-rbt-evidence-via-rbt-behavior, tool-rbt-behavior, tool-execution-platform, family:tool.scout.dynamic.general.**, family:tool.scout.dynamic.worker.**]
summary: 沿 JR → SR 比较 campaign evidence，覆盖全部声明并交付结果。
---

# Domain RBT Reviewer

当 Reviewer 在 Runtime Behavioral Test（RBT）Domain 中收到有效 JR/SR，需要独立查询同次 campaign evidence 并比较预期时使用本技能。后续 `RBT` 均表示 Runtime Behavioral Test。

本技能拥有 JR/SR 与实际 evidence 的比较和本轮审查结论。BDD、源码到声明的语义映射由 Executor 负责；Execution Pack 的格式约束不属于 Reviewer。Behavioral 查询的 dynamic-tool contract 由 `tool-rbt-behavior` 所有。

## Skill Type

- type: domain
- layout: workflow
- note: 本技能比较声明与 Runtime evidence，并在交付完成后关闭当前执行平台会话。

## Signal Collection

Reviewer 的 general Signal list 按以下顺序固定为：

1. `signal-rbt-evidence`
2. `signal-rbt-evidence-via-rbt-behavior`

Interface 定义完整 Evidence expectation，Via 只使用 campaign 历史 metadata/evidence 整体比较。Reviewer 不读取 codebase，不读取业务专属 Signal 或其它类型专用 Via。

## Core Use

使用本技能处理：

- 根据正式交付定位 JR/SR，并从 Runtime 提供的精确 `executor_history_ref` 取得本次执行 identity。
- 使用 Reviewer 自己的 `JarvisBehavior` dynamic tool 查询当前执行的 campaign metadata 和 historical evidence。
- 对每个 `SR-*`，使用 `signal-rbt-evidence` 解释完整预期，使用统一 Via 与实际 evidence 比较。
- 对每个 JR 表格行核对关键 identity、关联 SR 和实际 record；用实际 `sequence` 比较表中声明的 order。
- 覆盖全部 JR/SR，包括没有 JR 顺序位置的独立 absent SR。
- 形成与 Runtime evidence 一致的独立结论。
- 写入正式 Reviewer artifact 并提交 handoff。
- 在正式交付完成后关闭当前执行平台会话。
- 区分明确不匹配、证据不足和无法消费的声明输入。

不使用本技能处理：

- 激活 scenario、调用 trigger、修改 Executor 计划或重新执行测试来验真。
- 停用 scenario、停止 campaign，或补做 Executor 未完成的 cleanup。
- 操作 WebSocket session 或复用 Executor 的 dynamic-tool 调用上下文。
- 修改 Executor artifact、Runtime evidence journal 或 Guru Knowledge。
- 读取 BDD 原文、E-BDD、E-CODE、Human Input artifact、执行计划正文或 codebase，以重建或审查预期。
- 检查整个 Execution Pack 的目录、模板、必填字段或引用完整性，或从 command request/result 补齐业务断言。

## RBT Review Model

- Reviewer 从 `pack_ref` 直接读取 `journal-expected.md` 和 `signal-expected.md`。`pack_ref` 只用于定位这两份交付，不展开其他 Pack artifacts 或读取其编写 Skill/模板。
- JR/SR 作为有效输入消费；正常读取中遇到无法解析、缺失引用或语义不明时，报告影响比较的输入缺口，不开展 Pack 格式巡检，也不回读 BDD/源码修复解释。
- Runtime 单独提供精确 `executor_history_ref`；Reviewer 读取该 history 的 `executeFileRef`、`campaignId`、`scenarioId`、`status` 和 `runtimeSequence`，不打开执行计划。
- Reviewer 只通过自己的 `JarvisBehavior` dynamic tool 查询；WebSocket session 由 Scout Runtime 隔离和管理。RBT Runtime 保存的 campaign historical journal 是当次执行的 Signal 来源；Executor 的自然语言总结不能替代。
- `behavior.campaign.query` 返回的历史 evidence 是所有业务断言的实际证据来源。Runtime history 只用于当前执行 identity/ref 的定位和审计追溯，不进入 Signal 字段比较。
- 每个 SR 的 `signal_ref` 指向 `signal-rbt-evidence`。完整声明中的 claim、observation_scope 和 Fields 已明确业务含义；统一 Via 形成 `match / not_match / unresolved`，本 Domain 汇总 JR/SR 比较事实，不另行认证 BDD 到声明的映射。
- 每个 `SR-*` 和 `JR-*` 都必须形成一个 Review Pack 时间线点；没有直接 Runtime evidence 时也要保留 `warning` 或其它由 Review Pack contract 允许的事实状态。
- JR 表格通过 `signal_refs` 向下引用 present SR；不强制一对一。关键 identity 与 SR 保持一致，多个 SR 关联同一 JR 时必须可对应同一实际 record；表中 order 只表示声明的先后关系。
- Reviewer 不 activate、不 invoke，也不为了得到更好的证据再次执行测试。
- `match` 和明确的 `not_match` 都是完整审查结果，正常完成 review。`not_match` 不表示 Executor 应重新执行。
- 只有消费 JR/SR 时遇到的输入缺口，且无需新 Runtime 事实即可由 Executor 修正，才能形成 correction request；只报告具体缺口，不代替 Executor 审查来源或补写预期。
- 如果缺口需要新 platform run、新 trigger、新 capture 或其它新执行事实，本轮形成 evidence insufficient / invalid execution 结论，不要求重跑。
- Scenario 和 campaign lifecycle 由 Executor 推进、Runtime 记录。Reviewer 可以保留已有审计限制，但不调用 cleanup，也不将其成功与否作为业务 Evidence。
- 正式 Reviewer artifact、时间线状态和 handoff 由 `domain-rbt-review-pack` 定义；本技能只提供 JR/SR 比较事实。

## Inputs

### I-001: Review Task
---

描述：

- 正式交付中的 BDD identity、`target_version`、`pack_ref` 和 `execute_file_ref`，用于定位 JR/SR 与关联执行。BDD/source refs 作为追溯引用保留，不展开正文。
- Runtime 提供的精确 `executor_history_ref`。

注意事项：

- 交付 identity 冲突、JR/SR 不可读或本次 Runtime identity 无法确认时，停止依赖这些输入的比较，不从普通消息、日志猜测或现场状态补齐。

### I-002: Runtime Execution Identity
---

描述：

- 从精确 history ref 读取 `executeFileRef`、`campaignId`、`scenarioId`、`status` 和 `runtimeSequence`，再与正式交付及 JR/SR Query Scope 核对。
- `executor_history_ref` 为当前 run root 下的稳定相对 ref；只以 `${SCOUT_RUN_ROOT}` 解析该路径，不扫描 history 目录寻找替代文件。

注意事项：

- identity 与正式交付或 JR/SR 的对应声明不一致时停止关联，不审阅执行计划或命令序列。
- history 不可读、字段缺失或 `executeFileRef` 不属于当前正式交付时停止关联，不扫描其它 history，也不按文件修改时间猜测。
- endpoint、WebSocket session 与 schema 由 Scout Runtime 管理，Reviewer 不读取、填写或核对这些值。

## Behavioral Tool Use

通过以下 Skill 使用 Behavioral 控制面：

```text
tool-rbt-behavior
```

允许的审查命令：

```text
behavior.campaign.query
```

本技能按 JR/SR 决定查询范围和比较目标；Dynamic Tool 输入、Agent 可见输出、失败和退出边界遵守该 Tool Skill。

## Execution Tool Use

正式审查交付完成后，通过 `tool-execution-platform` 调用一次 `ExecutionPlatform` 的 `shutdown`。该操作只结束当前 Scout Run 的执行平台会话，不参与 JR/SR 比较，也不改变已经形成的审查结论。

## Workflow Overview

Phase 说明：

- Phase 1：读取 JR/SR，并关联本次 Runtime execution identity。
- Phase 2：按 JR 表和 SR 的定位条件查询 campaign，对完整 SR 逐字段比较，再核对 JR 的实际顺序。
- Phase 3：汇总全部 JR/SR 的比较事实、差异和无法判断项。
- Phase 4：写入正式审查交付，关闭执行平台会话并提交 handoff。

## Review Output Boundary

Reviewer 将独立结论、campaign evidence、实际检查范围、限制、冲突和阻塞整理为 `review-result.json`，再交给 `domain-rbt-review-pack` 和 `rbt-review-report` 生成正式 artifact。`executorHistoryRef` 只用于审计追溯，不作为 Signal 的实际值来源。

Reviewer 不复制完整 Runtime evidence，不把 Executor cleanup success 当作预期匹配，也不自行定义临时交付格式。

## Phase 1: Confirm Review Boundary
---

直接读取交付的 JR/SR，按 JR 的 `signal_refs` 进入相应 SR，并保留 SR 文件中未被 JR 引用的预期。将声明的 campaign/scenario 范围关联到本次 Runtime identity。到 SR 即结束预期读取，不沿 `bdd_refs`、`code_refs` 继续展开。

有效性是输入前提，不要求 Reviewer 重新验证整个 Pack。读取中发现某项声明无法直接理解或消费时，保留具体输入缺口；不把来源资料不可读作为 JR/SR 比较的额外门禁。

Exit：

- JR/SR 可消费，且本次 campaign/scenario identity 足以开始查询。

Blocked：

- JR/SR 不可消费、本次执行 identity 无法唯一关联，或 required Tool Skill 不可用时停止相关比较。

Partial：

- 可以列出已确认输入和缺口，但不得查询不确定的 campaign、scenario 或 evidence source。

## Phase 2: Query Runtime Evidence
---

先使用 `behavior.campaign.query` 按 history 中的 `campaignId` 查询 campaign metadata 和 historical evidence journal。同一 execution identity 与查询 scope 已取得成功结果后，全程复用该结果，不重复查询。

对每个 `SR-*`：

1. 使用 Interface 确认完整 SR 的 claim、presence、observation_scope 与 Fields 中声明的比较语义。
2. 按统一 Via 核对查询范围与采集可见性，使用 locate 字段定位全部 candidates，再在同一 record 上执行 assert 的比较语义；不默认要求所有原始表示精确相同，也不自行放宽声明的条件。
3. 保留不符合断言的 records，形成整体 `match / not_match / unresolved`；不把错误值过滤成缺失。
4. 保留 query ref、record locator、全部候选、原始字段值、比较依据及未能核验的边界；表示不同而语义匹配时保留差异与通过理由，不回读 codebase 或使用 execution history 补值。

按 JR 表格核对：

1. 沿 `signal_refs` 取得关联 SR 的实际候选，用声明的定位条件核对同一 record；关键列中作为 assert 的值仍按断言比较，不能拿预期结果排除错误候选。
2. 一行关联多个 SR 时确认其定位到同一实际 record；若明确指向不同 records，记录关系不匹配；无法消歧则为 unresolved。不要求 SR 反向登记 JR。
3. 对填写数字 order 的行，用对应实际 `sequence` 检查递增关系；order 为 none 的行不参加顺序判断。不要用数组位置代替实际 sequence。
4. 实际 records 及 sequence 明确而顺序相反时为 not_match；缺失或歧义使关系无法比较时为 unresolved，并保留相应 SR 的独立结果。
5. JR 比较只记录关键 identity、record locator 和实际顺序；完整业务字段判断保留在对应 SR 点。

Exit：

- 已取得可引用的 campaign query 结果，且每个 `SR-*` 与 `JR-*` 都已形成比较事实或明确 unresolved 原因。

Blocked：

- Behavioral Tool、campaign identity、Interface 或 Via 不可用时停止相关验证；查询证据不足时保留 unresolved。

Partial：

- 某一 Signal 为 `not_match` 或 `unresolved` 时保留其它独立 Signal 的比较事实，不用其它 record 补造它。

## Phase 3: Summarize Comparisons
---

以已交付的 JR/SR 为比较基准，汇总：

- 每个 SR 的完整声明与实际 evidence 是否匹配，包括独立 absent SR。
- 每个 JR 是否关联到实际 record，且声明的 order 是否符合实际 sequence 关系。
- 查询证据是否属于本次 campaign/scenario，观察范围是否足以支持比较。
- 已声明范围内的冲突 evidence、字段差异及 unresolved 原因。

将比较事实交给 Review Pack Skill 映射为正式结论状态；不重新拆解 BDD、不补充未声明的测试要求，也不把 cleanup 状态放入比较结论。明确的 `not_match` 是有效否定结论，不是 workflow error。

Exit：

- 已形成明确判断，并且每个支持或否定判断都有直接 Runtime evidence 或明确缺失事实。

Blocked：

- JR/SR 与查询结果无法关联，或关键查询因能力缺失无法完成时停止相关判断，并保留阻塞事实。

Partial：

- 证据可读但不足以判断某项声明时，保留 unresolved，不将其改写为匹配或不匹配。

## Phase 4: Submit Review
---

把本技能产生的业务事实按 `domain-rbt-review-pack` 的 `templates/review-result.md` 写入当前 Reviewer artifact root 下的 `review-pack/review-result.json`，再通过已挂载的 `rbt-review-report` 工具生成同目录 `review-report.html`。正式产物完成后调用 `ExecutionPlatform` 的 `shutdown`，成功关闭当前执行平台会话，再提交该 Pack 的正式 handoff。Via 的 `unresolved` 或证据不足应作为 `warning` 写入时间线；`match`、`not_match`、evidence insufficient 和 invalid execution 均作为完整审查结果正常提交。

JR/SR 输入缺口确需 Executor 修正且无需新执行事实时，提交 correction request，指出无法消费的位置及原因；不要求 Reviewer 回读来源确认改法，也不允许重新运行平台或 Runtime。

Exit：

- `review-result.json` 和 `review-report.html` 已形成，时间线覆盖全部 JR/SR，JR 表中的 order 已按实际 Runtime sequence 核对或保留明确无法比较的原因，且当前执行平台会话已经关闭；或者已形成无需新执行事实即可处理的明确 correction request。

Blocked：

- `domain-rbt-review-pack`、`rbt-review-report` 或 `ExecutionPlatform` 不可见，输入校验失败，正式交付不可写，或当前执行平台会话无法关闭时不得提交 handoff。Executor cleanup 未完成时如实引用该限制，不由 Reviewer 补做。

Partial：

- 允许提交 `not_match`、证据不足、执行无效或上游 cleanup 不完整的独立判断；不得把它们改写成 workflow error 或重跑请求。

## Workflow Exit Rules (Enforcement)

- XR-001：Phase 2 只能在 JR/SR 可消费且本次 Runtime execution identity 已关联后开始。
- XR-002：只有 Phase 2 查询完成并保留实际结果后，才能形成预期与实际的比较结论。
- XR-003：只有 `review-result.json` 已通过 `rbt-review-report` 生成 HTML、Review Pack contract 与查询结果一致，且 `ExecutionPlatform shutdown` 已成功时，才能提交当前 Reviewer task。

## Evidence Rules (Enforcement)

- ER-001：JR/SR 定义本轮预期；实际业务事实只接受 campaign 查询证据与 Via 比较结果。
- ER-002：Runtime history 只用于执行 identity/ref 定位与审计，不能提供 Signal 实际值；Executor summary 和源码解释也不能替代查询证据。
- ER-003：空 evidence、缺失 evidence 和与声明冲突的 evidence 必须保持各自语义，不能统一改写为失败或成功。
- ER-004：Reviewer 必须处理全部 `SR-*`，包括未被 JR 引用的 absent 预期；不得按 kind、sourceId 或 presence 选择性忽略。
- ER-005：Reviewer 逐行处理 JR 表，沿 `JR -> SR` 读取到完整声明为止；BDD/code refs 只保留追溯，不展开来源，也不要求下层登记消费者。

## Failure Rules (Enforcement)

- FR-001：查询失败必须按实际失败层次记录；不能据此直接判定预期不匹配。
- FR-002：Executor cleanup 失败只能作为上游限制引用，不能覆盖已经由证据形成的 conclusion。
- FR-003：明确 `not_match`、证据不足或执行无效是审查结论，不是 Reviewer task 失败。

## Blocking Rules (Enforcement)

- BR-001：无法将 Runtime evidence 唯一关联到本次 campaign 和 scenario 时，阻塞相关匹配判断。
- BR-002：Review Pack Skill、其模板或 `rbt-review-report` 不可见时，阻塞正式 handoff，不以临时格式替代。

## Retry Rules (Enforcement)

- RR-001：query 重试严格遵守 `tool-rbt-behavior`；不得通过重复查询、重新执行或修改条件追求预期结论。
- RR-002：Reviewer 不要求重新运行平台、campaign、Scenario、trigger 或 capture；需要这些动作才能补齐时，直接保留本轮证据不足或执行无效结论。

## Prohibited Rules (Enforcement)

- PR-001：禁止 Reviewer 调用 `behavior.campaign.start`、`behavior.scenario.activate`、`behavior.node.variants`、`behavior.trigger.invoke`、`behavior.evidence.capture`、`behavior.scenario.deactivate` 或 `behavior.campaign.stop`。
- PR-002：禁止 Reviewer 复用 Executor 的 dynamic-tool 调用上下文，或重新执行测试来补证据。
- PR-003：禁止修改 Executor artifact、Runtime evidence 或 BDD source。
- PR-004：禁止把 Executor cleanup success、连接成功、命令 success 或非空 evidence 单独解释为预期已匹配。
- PR-005：禁止把 `not_match` 当作 correction，或借 correction 要求 Executor 产生新的 Runtime 事实。
- PR-006：禁止回读 BDD/E-CODE/codebase 重建预期，或把 Execution Pack 格式审查作为 Reviewer 的工作。

## Checklist

- JR/SR 已读取，本次 Runtime execution identity 已关联。
- 查询范围只服务当前 JR/SR；execution history 仅追溯，所有业务实际值都来自 campaign evidence。
- 每个 `SR-*` 都已按统一 Interface 和 Via 形成比较事实，未被 JR 引用的 absent SR 也已覆盖。
- 独立判断由直接 Runtime evidence 或明确缺失事实支持。
- `match`、`not_match`、evidence insufficient 和 invalid execution 均按完整审查结果提交；只有消费声明时发现且无需重跑即可修复的输入缺口才要求 correction。
- 报告覆盖全部 JR/SR；JR 表的 order 与实际 sequence 已比较，SR 的全部字段已整体比较。
- 没有检查 Execution Pack 格式或回读 BDD/E-CODE/codebase；没有 activate、invoke、复用 Executor dynamic-tool 上下文或重新执行测试。
- 没有调用 cleanup 命令，也没有替 Executor 修复 lifecycle 状态。
- 正式 handoff 由 Review Pack Skill 形成；本技能不定义 Pack schema、HTML/CSS 或状态汇总实现。

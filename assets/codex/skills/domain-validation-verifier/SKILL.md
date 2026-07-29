---
assetKind: scout.skill
name: domain-validation-verifier
description: Scout Verifier 在 accepted Research Pack Gate 后消费 verification manual、采集代码或运行信号，并逐项形成 BDD Verification Report 时使用。
id: domain-validation-verifier
version: 0.2.1
phase: [verify]
tags: [scout, validation, bdd, verification, evidence, workflow]
devices: [any]
dependencies:
  skills:
    required: [tool-jarvis-codebase]
  shellTools:
    required: [scoutAssets, jarvis, codegraph, git]
    optional: [rg, sed, find, cat]
  mcpServers:
    optional: [scout_local_capability]
  plugins:
    optional: [scout-local-capability-plugin]
summary: 从 accepted Research Pack Gate 进入实际验证并形成 Verification Report。
---

# Domain Validation Verifier

当 Verifier 已收到 accepted Research Pack Gate，需要围绕 verification points 采集证据并形成 BDD Verification Report 时使用本技能。

本技能定义 Validation 验证工作流；代码库检索方法由 `tool-jarvis-codebase` 所有，具体信号语义和实现无关的 Signal Output Contract 由对应 Signal Skill 所有，每个具体 Acquisition 的操作规则由该 Acquisition Skill 所有。

## Skill Type

- type: workflow
- structure_level: full
- note: 本技能拥有 Validation observed claim 和 Verification Report，不重新定义 Research claim。

## Core Use

使用本技能处理：

- 核对 accepted Research Gate、Research pack、verification manual 和验证点输入。
- 围绕每个 verification point 选择并采集可定位信号。
- 按当前 Signal contract、目标环境和挂载能力选择适用采集实现。
- 区分代码事实、配置事实、运行 observation、工具活动和人工确认。
- 为每个验证点形成独立结论与 evidence refs。
- 提交可供 Validator gate 的 Verification Report。

不使用本技能处理：

- 从原始外部资料重新定位或清洗 BDD。
- 修改代码、配置或 Research artifact。
- 代替 Validator 判断产物是否可交付。
- 在缺少证据时声明 BDD 已成立。
- 把 Signal Skill 当作采集实现，或让 Acquisition 改写 Manual 的匹配 requirement。

## Validation Verification Model

- Verification Manual 锁定验证点、用户画像、Given / When / Then、supporting evidence 和 signals to collect，不等于运行时已验证。
- Knowledge evidence 支撑意图和规格；当前版本代码证据支撑 implementation claim；真实运行信号支撑 observed claim。
- 工具调用本身属于 Activity State，只有被保存为可定位 evidence ref 后才能支撑 Verification Report。
- Signal requirement 定义要观察什么；Signal contract 和适用 Acquisition 定义信号及其采集边界；Verifier 拥有选择、执行和解释责任。
- `verified` 只用于可定位 observation 直接满足该 verification point 的 requirement。
- `not_verified` 只用于可定位 observation 直接反证目标行为；执行失败、权限失败、解析失败、超时或空结果都不能成为 `not_verified`。
- `insufficient_evidence` 表示已取得的可定位 observation 不足以支持或反证 requirement；`blocked` 表示必要采集或解释无法执行。
- 每个 verification point 独立使用 `verified`、`not_verified`、`insufficient_evidence` 或 `blocked`，Verification Report 不用单一总体状态覆盖逐项结论。
- 总体状态不得掩盖单个 verification point 的失败、证据不足或阻塞。

## Native Subagent Strategy

- 本技能明确授权父 Verifier 在预计能够提高当前验证效率时自主决定是否使用 Codex native subagent；是否派发、派发数量以及并行或串行方式由父 Verifier 判断，不构成 Phase 的必需步骤。
- Phase 1 由父 Verifier 锁定 accepted Research Gate context、唯一 Research pack、verification manual、verification points、当前版本和执行边界；输入未闭环时不得派发依赖这些输入的子任务。
- 进入 Phase 2 时，父 Verifier 先在当前 plan 中列出 verification point、候选信号范围及其环境依赖。只有存在边界稳定、互不依赖的 verification point，且并行收益高于启动、等待和聚合成本时才派发；只读证据定位与候选信号采集是适合委派的候选范围，但不要求固定数量或必须并行。
- 只读代码、配置、已有日志和文件证据可以并行检查；具体工具是否可并发必须遵守其当前说明和副作用约束，不能仅因工具可用就自动并行。
- 共享同一设备、应用 session、用户账号、配置状态、部署目标或其它可变外部环境的操作必须由父 Verifier 串行调度；需要授权、有破坏性或会改变后续验证前提的操作不得交给 child 自主执行。
- child 只返回中文 observation 候选、原始信号位置、执行命令、环境信息、失败命令和 limitations；不得调用 Scout dynamic tool、修改 Research artifact、写最终 Verification Report 或提交 task。
- Phase 3 的 evidence ref 确认、verification point 结论、跨点一致性检查、正式 artifact 聚合和 handoff 只能由父 Verifier 完成。
- 父 Verifier 决定不派发时直接自行执行，不需要记录 fallback 原因；派发失败或结果不可用时，可以在停止或释放对应 child 后收回该范围，不得与仍在执行的 child 重复验证。

## Inputs

### I-001: Accepted Research Gate Context
---

描述：

- accepted Research Pack Gate ref、唯一 Research pack ref、该 Gate 实际检查的 pack digest、evidence registry ref、verification manual ref、上游 task ids 和限制。

注意事项：

- Research Gate 必须为 `accepted`，且 Gate 中的 pack ref / digest 必须与 task 输入完全一致。
- 通过 evidence registry ref 和 verification manual ref 解析详细 artifact refs、evidence refs 和验证点，不要求 task prompt 复制这些内容。
- 缺少 accepted Gate、唯一 pack ref 或匹配 digest 时交回 Coordinator，不自行重做 Research，也不依据旧 Gate 开始验证。

### I-002: Verification Manual
---

描述：

- verification manual ref、verification points、用户画像、Given / When / Then、supporting evidence ids 和 signals to collect。

注意事项：

- 不修改 manual 的验证点或自行增加成功标准。
- 对每个 `signal_ref` 读取当前挂载的 Signal Skill；Signal Skill 不可见或 requirement 不完整时停止受影响验证点。
- manual refs 不闭环时记录阻塞并交由 Validator 或上游处理。

### I-003: Execution Boundary
---

描述：

- 当前版本、codebase、平台、设备、配置、可用工具和允许采集的信号范围。

注意事项：

- 使用能力前确认当前 mount 可见性和工具说明。
- 缺少某类运行能力时，只影响依赖该能力的验证点，不得伪造 observation。

## Validation Verification Workflow

- Phase 1：核对 Research handoff 和 verification points。
- Phase 2：按验证点采集、保存和关联信号。
- Phase 3：形成并提交 Verification Report。

## Verification Report Output Layout

当前 Verifier task 固定写入：

```text
${SCOUT_ARTIFACT_ROOT}/verification-report.md
```

首次验证和 Gate follow-up 都原地修正同一 report；不得创建 `verification-report-v2.md`、`verification-report-final.md` 或其它隐式版本。历史检查事实由 Validator 的不可变 Gate 记录保存。

使用模板：

```text
templates/verification-report.md
```

Verification Report 必须记录：

- report state、accepted Research Gate、pack / manual refs。
- 每个 verification point 的独立结论。
- evidence refs、Signal / Acquisition refs、采集方法、版本和环境 provenance。
- failed commands、retry log、limitations 和 blocking items。
- 未覆盖范围和需人工确认项。

报告使用 `draft + partial`、`ready + complete` 或 `blocked + blocked` 表达 artifact 完成状态；这组状态不替代每个 verification point 的验证结论。只要报告已完整披露所有 verification point 的真实状态，即使其中包含 `not_verified`、`insufficient_evidence` 或 `blocked`，报告仍可使用 `ready + complete`。

`ready + complete` 时 `human_confirmation_needed` 必须为 `none`。存在 unresolved Human Confirmation Gate 时保持 report 为 `draft + partial`，当前 task 保持运行，不得提交 report handoff。

### Artifact Relationship Rules

- 摘要产物：Verification Report 汇总每个验证点的 observed claim 和结论。
- 明细产物：日志、截图、命令输出、代码位置或运行 observation 作为独立 evidence ref 保存。
- Registry / index：沿用 Research evidence registry；新增运行 evidence 必须有稳定 ref，不改写原 registry claim。
- Claim owner：Research artifact 拥有待验证事实；Verification Report 拥有 observed claim；Validator 拥有 gate claim。
- 下游引用规则：Validator 引用 report、verification point id 和 evidence refs，不依赖未归档工具活动。
- Ref 字段策略：每个 verification point 的 evidence refs 必填；无法形成时必须使用 evidence 不足或 blocked 结论。
- 历史关系：Verification Report 是当前 Verifier task 的 canonical 可修订产物；Validator 每次检查创建新的不可变 Gate 并绑定当时的 report digest。

## Phase 1: Confirm Verification Inputs
---

本阶段核对 accepted Research Gate、pack、manual 和执行边界是否足以开始验证。

注意事项：

- 逐项提取 verification point、用户画像、Given / When / Then 和 signals to collect。
- 核对 Research Gate 为 `accepted`，task 输入的 pack ref / digest 与 Gate 记录完全一致，并且 ref 确实定位当前 Research pack。
- 对每个 Signal requirement 核对 `signal_ref`、匹配字段和对应 Signal contract。
- 只根据目标环境、target、Signal contract 和当前挂载能力选择 Acquisition，不从 Signal contract 推断环境支持。
- 不把 Research complete 当作 Verification complete。
- 输入不一致时记录具体 artifact、字段和影响的验证点。

Exit：

- accepted Research Gate、唯一 pack、可执行验证点及其输入、环境、Signal requirements 和候选 Acquisitions 已明确。

Blocked：

- 缺少 accepted Research Gate、唯一 pack、manual、验证点、关键输入或执行环境，导致所有目标均不可执行时停止。

Partial：

- 只有部分验证点可执行时，记录范围后继续这些验证点。

## Phase 2: Collect Verification Evidence
---

本阶段针对每个验证点使用适用工具采集并保存证据。

注意事项：

- 代码检索必须遵守 `tool-jarvis-codebase` 的 provenance、symbol 和 source evidence 规则。
- 每个信号都必须遵守对应 Signal contract 和所选 Acquisition 的操作规则；contract 声明 `source_signal` 时按其要求保留来源 provenance。
- MCP server 和 plugin 只按当前说明与授权使用。
- 每个信号按其 contract 记录 Signal、Acquisition、原始来源、locator、版本、环境、覆盖范围和限制。
- Acquisition 不得修改 Manual 的 `match`、`non_match`、correlation、ordering 或 observation window。
- 失败、空结果和无法执行也是验证事实，但不能记为成功证据。
- 失败、空结果或未执行只能导向 `insufficient_evidence` 或 `blocked`；只有直接反证 requirement 的可定位 observation 才能导向 `not_verified`。

Exit：

- 每个可执行验证点已有足够 evidence refs，或已形成明确的 evidence 不足、失败或阻塞记录。

Blocked：

- required capability、权限或目标环境不可用且没有其它合法信号来源时停止受影响验证点。

Partial：

- 部分信号已收集但不足以支持结论时保留 evidence refs，并标记 `insufficient_evidence`。

## Phase 3: Produce Verification Report
---

本阶段逐项解释证据与验证点的关系，并形成正式 report。

注意事项：

- 不能只给总体结论；每个 verification point 都必须有状态和依据。
- `verified` 必须由可定位 observation 直接满足 requirement。
- `not_verified` 必须由可定位 observation 直接反证目标行为；命令失败、工具错误、权限问题、超时、空结果或未执行不能用作反证。
- 没有足够 observation 支持或反证时使用 `insufficient_evidence`；必要采集或解释不可执行时使用 `blocked`。
- 按 `templates/verification-report.md` 原地写入或修正 `verification-report.md`，不得创建报告版本副本。
- 必需事实进入 Human Confirmation Gate 后必须等待匹配回复；未解除时不得把 report 标记为 `ready + complete` 或提交 handoff。
- report 必须通过正式 task handoff 提交给 Coordinator 路由 Validator。
- 正式 handoff 必须使用下列固定八字段；英文 Markdown 标题和字段 key 保持原样，字段内容使用中文，字段不得增加、删除、改名或展开为额外摘要：

```markdown
# Verifier Handoff: Verification Report

- verifier_task_id: <当前 Verifier task id>
- report_ref: <当前 canonical Verification Report ref>
- research_gate_ref: <作为本次验证入口的 accepted Research Pack Gate ref>
- checked_pack_ref: <accepted Gate 对应的唯一 Research pack ref>
- checked_pack_digest: sha256:<hex>
- verification_point_states: <逐项写 VP-* 与 verified | not_verified | insufficient_evidence | blocked>
- unverified_scope_or_limitations: <未覆盖范围或限制；没有时写 none>
- continuation_entry: <下一步消费入口>
```

- handoff 不复制 observation、evidence 正文、命令输出或逐项判断理由；这些内容只能通过 `report_ref` 消费。

Exit：

- Verification Report 已写入授权位置并通过正式 task 入口提交。

Blocked：

- report 不可写、evidence refs 不可定位或 handoff 失败时不得报告完成。

Partial：

- report 可以包含不同验证点状态，但必须准确披露整体未完成范围。

## Workflow Exit Rules (Enforcement)

- XR-001：不得跳过 verification point 输入核对直接执行泛化验证。
- XR-002：任一验证点缺少足够证据时，不得用总体 verified 覆盖。
- XR-003：完成态 Verification Report 必须包含逐项状态、evidence refs、provenance 和限制。
- XR-004：每个 Signal requirement 必须具有符合对应 contract 的可执行采集路径；没有适用实现时只阻塞依赖该信号的范围。
- XR-005：没有 accepted Research Pack Gate、唯一 pack ref 和匹配 digest 时不得开始验证或写 Verification Report。
- XR-006：Gate follow-up 必须原地修正同一 `verification-report.md`；不得创建隐式版本目录或文件。
- XR-007：正式 handoff 必须只使用固定八字段并明确引用 canonical report。
- XR-008：存在 unresolved Human Confirmation Gate 时不得提交 Verification Report handoff。

## Evidence Rules (Enforcement)

- ER-001：工具调用、查询命令和过程消息不自动成为 evidence。
- ER-002：observed claim 必须引用可重放的日志、截图、命令输出或真实环境 observation。
- ER-003：代码 evidence 只证明当前版本实现；不能单独证明运行行为已经发生。
- ER-004：矛盾证据必须同时保留并解释，不能只选择支持预期的一侧。
- ER-005：Signal Skill 和 Manual requirement 不证明已经观察到行为；runtime evidence 必须按对应 contract 保留 Acquisition、原始来源和 provenance。
- ER-006：`not_verified` 必须引用直接反证 requirement 的 observation；采集过程失败或 observation 缺失不是反证。

## Failure Rules (Enforcement)

- FR-001：工具失败、空输出、权限拒绝或解析失败时记录命令、错误、影响验证点和 limitation。
- FR-002：evidence ref 无法保存或定位时不得用于 report 结论。
- FR-003：执行失败、权限失败、解析失败、超时或空结果不得改写成 `verified` 或 `not_verified`；只能形成 `insufficient_evidence` 或 `blocked`。

## Blocking Rules (Enforcement)

- BR-001：缺少 accepted Research Pack Gate、匹配 pack ref / digest 或 verification manual 时必须停止。
- BR-002：required capability 对目标验证点不可用时将该点标记 blocked。
- BR-003：artifact target 不可写或正式 handoff 不可用时不得报告 task 完成。
- BR-004：Manual 引用的 Signal contract 不可读，或没有符合 contract 且支持目标环境的采集实现时，依赖该信号的验证点不得继续采集。

## Retry Rules (Enforcement)

- RR-001：只对瞬时、只读或明确可恢复的采集失败进行有限重试，并记录 retry log。
- RR-002：有副作用的设备、配置或环境操作必须遵守工具授权，不能自动重复。
- RR-003：不得通过改变用户画像、Given / When / Then、版本或环境来制造预期结果。

## Prohibited Rules (Enforcement)

- PR-001：禁止修改代码或配置来使验证通过。
- PR-002：禁止重新定义 Research claim、verification point 或成功标准。
- PR-003：禁止代替 Validator 给出最终 gate。
- PR-004：禁止用 Acquisition 的过滤结果替代 Signal contract 要求的原始来源，或在采集阶段静默改变 Signal requirement。
- PR-005：禁止把执行失败、空结果或未执行写成目标行为的直接反证。

## Example

输入：

```text
accepted Research Pack Gate 提供唯一 pack ref / digest，pack 中的 manual 定义 VP-001 和待采集 runtime signal。
```

流程：

1. 核对 accepted Gate、pack digest、VP-001 的 Given / When / Then 和执行边界。
2. 采集并保存代码与运行证据，关联稳定 evidence refs。
3. 为 VP-001 给出独立状态，原地写入 `verification-report.md` 并按固定 handoff 提交。

输出：

- Verification Report ref。
- VP-001 状态、evidence refs、failed commands、limitations 和 blocking items。

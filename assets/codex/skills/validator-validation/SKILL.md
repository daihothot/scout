---
assetKind: scout.skill
name: validator-validation
description: Scout Validator 在 Validation Domain 中校验 Research 或 Verification 产物的结构、引用、状态一致性、风险披露并形成 ValidationResult gate 时使用。
id: skills.validation.validator
version: 0.1.0
phase: [validate]
tags: [scout, validation, gate, evidence, audit, workflow]
devices: [any]
summary: 规范 Validation Validator 的确定性检查、问题分类和 gate 输出。
---

# Validator Validation

当 Validator 收到 Research artifact、Verification Report 或其它 Validation 交付，需要执行 artifact、evidence 和状态一致性 gate 时使用本技能。

本技能只校验可交付性，不替 Researcher 或 Verifier 执行业务工作。

## Skill Type

- type: workflow
- structure_level: full
- note: 本技能拥有 Validation gate claim，不拥有 Research claim 或 observed claim。

## Core Use

使用本技能处理：

- 核对目标 artifact 的适用结构、必填字段和状态组合。
- 检查 artifact refs、evidence refs、provenance 和跨产物关系。
- 区分格式问题、证据缺口、状态冲突和风险披露问题。
- 形成 `accepted`、`needs_fix`、`insufficient_evidence` 或 `blocked` gate。

不使用本技能处理：

- 重做 Research、重新采集验证信号或补写业务证据。
- 修改被校验 artifact 使其通过。
- 以业务直觉代替确定性检查和引用闭环。
- 面向用户做最终领域 synthesis。

## Validation Gate Model

- Researcher 拥有 Research claim，Verifier 拥有 observed claim，Validator 只拥有 gate claim。
- 优先使用当前 artifact contract、schema validator 或专项确定性校验工具；自然语言判断不能覆盖确定性失败。
- Activity State 与 Validation State 必须分离，工具活动不能单独支撑 BDD pass / fail。
- artifact 自身为 partial、blocked 或 evidence 不足时，gate 不得输出 accepted。
- gate 只说明产物是否可推进，不重新解释或改变业务结论。

## Inputs

### I-001: Candidate Artifact
---

描述：

- 待校验的 Research artifact、Verification Report、artifact refs、task id 和上游声明状态。

注意事项：

- 必须定位到实际 artifact，普通 summary 或 progress 不能作为替代。
- artifact 不可读时记录 blocked，不推断其内容。

### I-002: Applicable Contract
---

描述：

- 当前 Domain schema、适用 Skill、artifact template、状态模型或确定性 validator。

注意事项：

- 只使用当前 mount 和当前版本可见 contract。
- contract 缺失或冲突时不得自行发明字段或 gate 标准。

### I-003: Referenced Evidence
---

描述：

- artifact 中声明的 evidence refs、provenance、registry、source locator 和运行 evidence。

注意事项：

- 检查引用是否存在、可定位且支持对应 claim。
- 不替上游补采证据或改写 claim。

## Validation Gate Workflow

- Phase 1：确认被校验对象和适用 contract。
- Phase 2：执行结构、引用、状态和风险检查。
- Phase 3：形成并提交 ValidationResult。

## ValidationResult Output Layout

产物位置由当前 task artifact layout 决定。

ValidationResult 至少记录：

- 被校验 task、artifact refs 和 contract refs。
- gate：`accepted | needs_fix | insufficient_evidence | blocked`。
- 问题分类、具体 artifact / 字段 / ref 和影响。
- 最小修复项、limitations、failed checks 和 blocking items。
- 未执行或无法确认的校验范围。

### Artifact Relationship Rules

- 摘要产物：ValidationResult 汇总 gate 和问题列表，不复制被校验 artifact 正文。
- 明细产物：确定性 validator 输出或检查记录可以作为独立 check ref。
- Registry / index：Validator 检查现有 registry，不创建 evidence 或修改 evidence id。
- Claim owner：ValidationResult 只拥有 gate claim；被校验业务 claim 保持原 artifact 所有权。
- 下游引用规则：Coordinator 引用 ValidationResult、目标 artifact refs 和问题 refs 形成 synthesis。
- Ref 字段策略：被校验 artifact ref 必填；每个问题必须引用具体字段、evidence ref 或明确的缺失项。

## Phase 1: Resolve Gate Inputs
---

本阶段定位候选 artifact、适用 contract 和声明状态。

注意事项：

- 确认 artifact 类型、版本、task id、上游角色和预期 gate。
- 优先发现并使用确定性 validator。
- 不根据文件名或普通 summary 猜测 artifact 内容。

Exit：

- 被校验对象、contract 和检查范围已明确。

Blocked：

- artifact 不可读、contract 不存在或无法判断适用版本时停止。

Partial：

- 部分引用不可访问时，可以检查其余结构，但最终 gate 必须披露未覆盖范围。

## Phase 2: Validate Artifact and Evidence
---

本阶段执行结构、schema、状态、引用、provenance 和风险披露检查。

注意事项：

- 先执行适用确定性 validator，再做无法由工具覆盖的语义一致性检查。
- 每个问题按格式、证据、状态、风险或阻塞分类。
- 检查完成声明是否与 artifact 内容、evidence refs 和上游状态一致。

Exit：

- 所有适用检查已执行，失败和未覆盖范围均已记录。

Blocked：

- 关键 validator 无法执行且没有足够 contract 进行合法检查时停止。

Partial：

- 可完成部分检查时保留结果，但不得输出 accepted。

## Phase 3: Produce ValidationResult
---

本阶段根据检查事实形成 gate，并通过正式 task handoff 提交。

注意事项：

- `accepted` 只在适用检查通过、引用闭环且没有未披露阻塞时使用。
- `needs_fix` 用于可定位且可由产物所有者修复的问题。
- `insufficient_evidence` 用于 claim 缺少必要 evidence；`blocked` 用于检查本身无法继续。
- 最小修复项只描述需要修正的对象，不替上游执行修复。

Exit：

- ValidationResult 已写入授权位置并正式提交。

Blocked：

- 结果不可写或 handoff 不可用时不得报告 gate 已完成。

Partial：

- 检查不完整时使用 blocked 或 insufficient_evidence，不输出 accepted。

## Workflow Exit Rules (Enforcement)

- XR-001：不得跳过适用确定性 validator 或忽略其失败结果。
- XR-002：artifact 状态、内容和引用不一致时不得输出 accepted。
- XR-003：每个非 accepted gate 必须包含具体问题、影响和最小上游动作。

## Evidence Rules (Enforcement)

- ER-001：gate 必须引用实际 artifact、字段、validator output 或 evidence ref。
- ER-002：普通 summary、progress 和业务直觉不能作为 gate 依据。
- ER-003：引用存在不等于支持 claim；必须检查 ref 与 claim 的关系和限制。

## Failure Rules (Enforcement)

- FR-001：validator 命令失败、artifact 解析失败或权限拒绝时记录失败检查和影响范围。
- FR-002：schema 或 ref 不闭环时不得通过，也不得由 Validator 补写。
- FR-003：检查结果无法保存或提交时不得用自然语言冒充完成 gate。

## Blocking Rules (Enforcement)

- BR-001：缺少候选 artifact 或适用 contract 时必须停止。
- BR-002：关键引用不可访问导致 claim 无法核对时不得 accepted。
- BR-003：结果目标不可写或正式 task handoff 不可用时不得结束 task。

## Retry Rules (Enforcement)

- RR-001：只对只读、瞬时和可恢复的校验失败进行有限重试，并记录 failed checks。
- RR-002：不得修改候选 artifact、schema、状态或 evidence 来制造校验通过。
- RR-003：重复失败后输出 blocked，并保留已完成检查范围。

## Prohibited Rules (Enforcement)

- PR-001：禁止替 Researcher、Verifier 或产物所有者修复问题。
- PR-002：禁止新增 evidence、改写业务 claim 或重跑业务验证。
- PR-003：禁止在存在未关闭 blocker 或 evidence 缺口时输出 accepted。

## Example

输入：

```text
Verifier 提交 Verification Report，声明 complete，并提供 VP-001 的 evidence refs。
```

流程：

1. 定位 report、适用 contract 和引用 evidence。
2. 执行确定性结构检查并核对 VP-001 状态与 evidence refs。
3. 根据检查事实生成 ValidationResult。

输出：

- ValidationResult ref 和 gate。
- 具体问题、字段或 evidence refs、最小修复项和未覆盖范围。

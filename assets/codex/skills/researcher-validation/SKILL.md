---
assetKind: scout.skill
name: researcher-validation
description: Scout Researcher 在 Validation Domain 中接收 BDD 定位输入、调用适用研究方法、形成可追溯 Research handoff 并为 Verifier 提供稳定验证输入时使用。
id: skills.validation.researcher
version: 0.1.0
phase: [research]
tags: [scout, validation, bdd, research, workflow]
devices: [any]
dependencies:
  skills:
    required: [guru-knowledge-research]
summary: 规范 Validation Researcher 的输入收敛、方法委派和领域 handoff。
---

# Researcher Validation

当 Researcher 在 Validation Domain 中需要把 BDD 定位输入收敛为可供下游消费的 Research handoff 时使用本技能。

本技能定义 Validation Research 的角色工作流；Guru knowledge、当前版本代码证据和 Research pack 的具体方法由 `guru-knowledge-research` 所有。

## Skill Type

- type: workflow
- structure_level: full
- note: 本技能是领域入口 Skill，不复制专项研究 Skill 的模板、命令或证据结构。

## Core Use

使用本技能处理：

- 检查 Coordinator task 是否提供可定位的 BDD 输入和当前研究边界。
- 选择并执行当前 Validation task 所需的研究方法 Skill。
- 区分已确认输入、来源内容、研究归纳、候选和未确认项。
- 将专项研究产物整理成稳定 Research handoff。

不使用本技能处理：

- 自行扩展到未分配的 BDD、产品、版本或来源范围。
- 重复定义 `guru-knowledge-research` 的 evidence pack、模板或验证手册字段。
- 执行运行时验证、判定 BDD 是否通过或执行最终 gate。
- 直接向用户请求输入。

## Validation Research Model

- Coordinator 提供的是 BDD 定位输入；唯一 BDD fact 由 Researcher 使用专项研究方法确认。
- Research artifact 负责锁定待验证功能点、来源、证据、限制和需人工确认项，不是运行时验证结论。
- Guru knowledge 属于研究来源；当前版本 implementation claim 必须遵守专项 Skill 的代码证据规则。
- `guru-knowledge-research` 是当前 Validation Research 的方法和产物所有者，本技能只负责进入条件和领域 handoff。
- Research handoff 的 complete、partial 或 blocked 必须与实际专项产物状态一致。

## Inputs

### I-001: Research Task
---

描述：

- Coordinator synthesis 后的 task id、验证目标、已确认用户意图、输入 refs、预期交付和禁止越权边界。

注意事项：

- 不读取或拼接未通过 task 提供的其它 Agent 上下文。
- task 不属于 Researcher 时停止并交回 Coordinator。

### I-002: BDD Locator
---

描述：

- BDD ID、Behavior 文件路径或可定位的 Guru SDK 场景描述。

注意事项：

- 多个候选、无候选或场景语义不完整时，不得自行选择。
- 需要人工补充时通过正式 handoff 交回 Coordinator。

### I-003: Product and Version Boundary
---

描述：

- 当前产品、版本、branch、commit、平台、用户画像线索和来源 refs。

注意事项：

- 当前版本代码证据所需边界缺失时，按专项 Skill 记录 partial、blocked 或需人工确认项。
- 不主动选择 latest 或扩大到其它 codebase。

## Validation Research Workflow

- Phase 1：确认 task、BDD locator 和研究边界。
- Phase 2：加载并执行适用研究方法 Skill。
- Phase 3：核对专项产物状态并提交领域 handoff。

## Research Handoff Output Layout

本技能不定义新的 canonical artifact 或模板。

输出要求：

- 正式 artifact 及字段结构由 `guru-knowledge-research` 定义。
- Research handoff 必须包含 task id、handoff state、artifact refs、evidence refs、限制、需人工确认项和继续入口。
- `complete` 只表示当前 Research 交付完整，不表示 BDD 已通过验证。

### Artifact Relationship Rules

- 摘要产物：Research handoff 只摘要专项 Research pack 的状态和关键 refs。
- 明细产物：由 `guru-knowledge-research` 及其依赖 Skill 所有。
- Registry / index：沿用专项 Skill 生成的 registry 和 index；本技能不重复创建。
- Claim owner：BDD、knowledge 和 implementation claim 的所有权遵守专项 Skill。
- 下游引用规则：Verifier 只消费正式 handoff 中提供的 artifact refs、evidence refs 和 verification manual ref。
- Ref 字段策略：本技能只传递已有 ref，不产生第二套 artifact_ref 或 evidence id。

## Phase 1: Confirm Research Boundary
---

本阶段确认任务属于 Validation Research，并检查 BDD 与版本边界。

注意事项：

- 保留 Coordinator 已确认内容、未确认内容和输入 refs。
- 判断 BDD 是否唯一定位需要实际研究，不以 Coordinator 推断替代。
- 缺少必要能力或产物写入位置时记录阻塞项。

Exit：

- 已确认可执行的 Research scope 和适用研究 Skill。

Blocked：

- task 职责不匹配、BDD 输入无法进入定位流程或 required Skill 不可见时停止。

Partial：

- BDD 可定位但版本或用户画像边界不完整时，允许进入专项 Skill 的 partial 流程并记录缺口。

## Phase 2: Execute Research Method
---

本阶段加载并执行 `guru-knowledge-research`，由它负责具体阶段、模板、命令和 evidence pack。

注意事项：

- 必须读取当前 mount 中实际 Skill 内容，不凭记忆执行。
- 不复制或弱化专项 Skill 的 evidence、provenance、状态和验证手册规则。
- 工具活动只有整理进正式 artifact 后才能成为 Research handoff 的引用对象。

Exit：

- 专项 Skill 已形成 complete、partial 或 blocked 的正式 Research 产物。

Blocked：

- 专项 Skill 的 required 输入、能力、模板或写入目标缺失时按其规则停止。

Partial：

- 专项 Skill 允许部分产出时，保留 phase resume、缺口和继续条件。

## Phase 3: Submit Research Handoff
---

本阶段检查 Research 产物状态和 handoff 摘要是否一致，并通过正式 task 入口提交。

注意事项：

- handoff 必须包含 Verification Manual 摘要或明确说明尚未形成及停留阶段。
- 不得用 artifact 文件列表替代状态、关键验证点和限制摘要。
- complete、partial、blocked 必须来自实际产物，不由自然语言自评。

Exit：

- 正式 Research handoff 已提交，且状态与产物一致。

Blocked：

- 产物无法写入、refs 不闭环或 handoff 无法提交时不得结束 task。

Partial：

- 已形成部分产物时提交 partial，并明确剩余工作、缺失条件和继续入口。

## Workflow Exit Rules (Enforcement)

- XR-001：不得跳过专项研究 Skill 定义的前置 Phase、模板或验证工具。
- XR-002：专项产物为 partial 或 blocked 时，领域 handoff 必须使用对应状态。
- XR-003：Research complete 必须包含可供下游消费的正式 artifact refs 和 Verification Manual 摘要。

## Evidence Rules (Enforcement)

- ER-001：Research 来源、knowledge evidence 和 code evidence 的成立条件由专项 Skill 定义。
- ER-002：Research artifact 只锁定验证内容和证据事实，不证明运行时行为已发生。
- ER-003：普通 summary、工具调用和共享记忆不得替代正式 evidence ref。

## Failure Rules (Enforcement)

- FR-001：专项 Skill、模板、命令或 artifact 写入失败时，保留 failed command、影响范围和 limitation。
- FR-002：BDD 无法唯一定位时不得继续形成唯一 verification point。
- FR-003：handoff 失败时不得用普通自然语言冒充 task terminal outcome。

## Blocking Rules (Enforcement)

- BR-001：缺少 `guru-knowledge-research` 或其 required capability 时必须停止依赖阶段。
- BR-002：BDD 无法唯一定位时必须向 Coordinator 交回最小补充问题。
- BR-003：正式产物不可写或无法提交时不得报告完成。

## Retry Rules (Enforcement)

- RR-001：重试遵守专项 Skill 的只读和副作用边界，并写入其 retry log。
- RR-002：不得通过更换 BDD、版本、repo 或来源范围制造成功。
- RR-003：重复失败后提交 blocked 或 partial，不循环执行相同失败路径。

## Prohibited Rules (Enforcement)

- PR-001：禁止把 Research 结果描述为 BDD 已验证或 gate 已通过。
- PR-002：禁止复制专项 Skill 的模板和业务规则形成第二套产物。
- PR-003：禁止直接面向用户请求输入或自行扩大研究范围。

## Example

输入：

```text
Coordinator 分配 account-anon-first-launch-signin 的 Research task，并提供目标 SDK 版本。
```

流程：

1. 确认 BDD locator、版本和 task 边界。
2. 加载 `guru-knowledge-research` 形成正式 Research pack。
3. 按实际产物状态提交 Research handoff。

输出：

- 专项 Skill 产生的 artifact refs 和 evidence refs。
- Research handoff state、Verification Manual 摘要、限制和继续入口。

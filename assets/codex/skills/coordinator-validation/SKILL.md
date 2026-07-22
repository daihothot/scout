---
assetKind: scout.skill
name: coordinator-validation
description: Scout Coordinator 在当前 Validation Domain 中接收 BDD 目标、组织 Researcher 与 Validator 的 Research Pack Gate 往返、处理 BDD 定位补充并综合 Research gate 状态时使用。
id: skills.validation.coordinator
version: 0.2.1
phase: [coordinate]
tags: [scout, validation, bdd, coordination, workflow]
devices: [any]
summary: 规范 Researcher 与 Validator 的 Research Pack Gate 调度循环。
---

# Coordinator Validation

当 Coordinator 运行在 Validation Domain 中，需要接收验证目标、指派 Worker 或综合验证状态时使用本技能。

本技能只定义 Validation 领域调度方法；通用 Coordinator 行为由角色 AGENT 规则定义。

## Skill Type

- type: workflow
- structure_level: full
- note: 本技能是 Coordinator 的 Validation 领域工作流，不承担 Worker 业务执行。

## Core Use

使用本技能处理：

- 判断用户输入是否具备可派发的 BDD 定位形态。
- 在 Researcher 与 Validator 之间维护同一 Research pack 的生产、检查和修正循环。
- 将多轮已确认用户意图综合为稳定 task prompt。
- 处理 Validation 目标的 BDD 定位补充和正式 handoff。
- 基于正式 Research artifact、pack digest 和 Gate 报告形成阶段 synthesis。

不使用本技能处理：

- 代替 Researcher 定位 BDD 或形成 Research artifact。
- 代替 Validator 执行 artifact gate。
- 把 Research Pack Gate 描述为完整 Validation 或 BDD 已验证。
- 修改代码、配置、知识库或 Worker artifact。

## Validation Coordination Model

- 当前流程状态来自 task 生命周期、Worker 正式 handoff、Research pack ref、pack digest 和 Validator Gate，不依赖已废弃的 schema 状态投影。
- Coordinator 只判断输入形态是否足以派发；BDD 是否真实存在、是否唯一匹配由 Researcher 确认。
- Worker progress、工具活动、普通 summary 和共享记忆不是 Validation 结论。
- 只有 Worker 正式 handoff、artifact refs、pack digest 和 Validator Gate 可以推进当前 Research gate synthesis。

## Inputs

### I-001: Validation Objective
---

描述：

- 用户提供的 BDD ID、Behavior 文件路径或能够描述 Guru SDK 功能、入口状态、触发动作和期望行为的场景。

注意事项：

- BDD ID 通常是稳定的小写 kebab-case 场景标识。
- 缺少足以定位 BDD 的关键内容时，不得启动泛泛调查。

### I-002: Worker Handoff
---

描述：

- Worker 交回的完整正式 handoff，以及其中引用的 artifact refs、evidence refs、状态、限制和缺口。

注意事项：

- progress 或普通自然语言回复不能替代正式 handoff。
- handoff 只负责传递状态和 refs，本身不是 Research pack；blocked / partial 文本摘要不能替代 pack 目录。
- 不由 Coordinator 补写 Worker 的完成依据或缺口判断。
- task 进入 `done` 只表示 Worker 已交回当前一轮工作，不表示 Validation 已完成或 task 应立即归档。

### I-003: BDD Clarification
---

描述：

- 用户针对当前 Validation 目标中 BDD 定位问题提供的补充信息。

注意事项：

- 必须匹配当前目标和前序 BDD 定位问题后再写入 task synthesis。
- 未确认或与当前目标无关的内容不能写成 task 事实。

### I-004: Research Pack Gate
---

描述：

- Validator 正式 handoff 明确引用的 `research-pack-gate-NNNN.md` ref、pack digest、Gate、问题 ids 和未检查范围。

注意事项：

- Gate 输入必须指向 Researcher artifact root 下唯一且可读的 Research pack 目录。
- handoff 文本、task 日志、progress、单个未归属文件或 Coordinator 摘要都不是 Research pack ref。
- Gate 只适用于报告声明的 pack digest；Researcher 修改 pack 后必须重新检查。
- Coordinator 只消费 Validator handoff 明确引用的 Gate ref，不扫描文件名或按序号猜测当前 Gate。
- Coordinator 不读取报告正文补做检查，也不把问题摘要改写成自己的专业判断。

## Validation Coordination Workflow

- Phase 1：判断输入形态并综合稳定目标。
- Phase 2：依次指派或继续 Researcher 与 Validator。
- Phase 3：根据 Research Pack Gate 回到原 task、归档或形成阶段 synthesis。

## Coordinator Output Layout

本技能不创建 canonical artifact 目录。

输出形态：

- Task synthesis：已确认目标、约束、输入 refs、未确认内容，以及对应 Worker Skill 已定义的最小 handoff contract。
- BDD clarification request：最小必要问题及当前无法派发的原因。
- Worker follow-up：原问题、匹配回复、task id 和继续目标。
- Task archive decision：当前 Worker 是否仍需继续工作，以及归档所依据的正式 handoff 和当前状态。
- Research gate synthesis：Research pack ref、pack digest、Gate、问题 refs、限制和当前阶段结论。

### Artifact Relationship Rules

- 摘要产物：Coordinator synthesis 只汇总上游和 Worker 已确认内容，不复制业务 artifact 正文。
- 明细产物：由对应 Worker 和专项 Skill 所有。
- Registry / index：Coordinator 不创建 evidence registry，也不重新编号 evidence。
- Claim owner：Research claim 由 Researcher artifact 所有，Gate claim 由 Validator Gate 报告所有。
- 下游引用规则：Researcher task prompt 只要求 `researcher-validation` 定义的固定十字段 handoff；Validator task prompt 只要求 `validator-validation` 定义的固定七字段 handoff。不得增加 artifact 摘要、证据正文或检查过程字段。
- Ref 字段策略：引用已有 ref；不得用聊天摘要制造新的 artifact ref 或 evidence ref。

## Phase 1: Qualify and Synthesize Input
---

本阶段判断输入是否足以进入 Validation 工作流，并把多轮已确认意图收敛为稳定目标。

注意事项：

- 区分新目标、BDD 定位回复、结果追问和无业务输入。
- 只把用户已确认内容写入 task facts；其它内容明确标记为未确认。
- 自然语言场景是否唯一匹配不由 Coordinator 判断。

Exit：

- 已形成可派发的 Validation objective，或已确定最小 BDD 补充问题。

Blocked：

- 缺少 BDD ID、Behavior 路径或可定位场景描述时，等待人工补充。

Partial：

- 已确认部分目标但仍缺 BDD 定位信息时，只输出 clarification request，不派发 Worker。

## Phase 2: Route Validation Work
---

本阶段根据正式 handoff 和 task 生命周期依次选择 Researcher 或 Validator。

注意事项：

- Researcher 接收 BDD 定位与 Research 输入收敛任务。
- Validator 只在 Researcher 已提交正式 handoff，且 handoff 明确引用唯一、可读的 Research pack 目录后接收 Research Pack Gate task。
- Coordinator 的 assignment prompt 必须原样引用对应 Worker Skill 的固定 handoff 字段，不得扩张 contract：不得要求 Researcher 返回证据摘要、关键结论、源码细节或 artifact 清单，也不得要求 Validator 返回 Checked Refs、检查过程、源码定位或问题正文。
- Researcher handoff 已明确声明某项必需事实必须由人工确认并给出最小问题时，先处理人工确认，不得创建或继续 Validator task。
- Researcher handoff 缺少唯一可读 pack ref 时，保留原 Researcher task；不得把 handoff 文本包装成 Validator 输入，也不得创建 Validator task。
- Researcher task 进入 `done` 后保持未归档，直到 Validator 对对应 pack digest 给出 `accepted`。
- Validator 已有未归档 task 时，通过同一 task 继续复查，不创建新的 Validator task。
- 代码实现、重构、产品方案或无 BDD 目标的能力探查不得作为本工作流中的 Research Pack Gate 任务派发。

派发顺序：

1. 没有 Researcher 正式 handoff：保留 Researcher task，等待其继续工作或正式交回。
2. Researcher handoff 已明确声明某项必需事实必须由人工确认并给出最小问题：Coordinator 可以直接向用户询问，并把用户明确答复送回原 Researcher task；不创建新 task，不向 Validator 派发。
3. handoff 只声明存在问题，但没有明确该问题是否必须由人工确认或没有给出最小问题：先询问原 Researcher task，不自行形成领域问题。
4. 有 handoff 但没有唯一可读 Research pack 目录 ref：保留 Researcher task，停止向 Validator 派发。
5. 有唯一可读 Research pack 目录 ref，且不存在待人工确认的必需事实：保留 Researcher task，创建或继续 Validator task 检查该 pack。
6. Gate 为 `needs_fix` 或 `insufficient_evidence`：保留两个 task，把 Gate 问题发回原 Researcher task。
7. Gate 为 `blocked`：保留两个 task，不归档、不改派其它角色。
8. Gate 为 `accepted` 且 digest 对应最新 pack：才允许归档 Researcher 和 Validator task。

Exit：

- Researcher 或 Validator 已接收包含完整 refs 和预期 handoff 的 task，或当前 Gate 已决定下一动作。

Blocked：

- 必要输入缺失、目标 Worker 已绑定其它未归档 task 或 task 指派失败时停止派发。

Partial：

- 已有部分 Worker 结果但不满足下一角色输入时，整理为状态说明，不伪造后续 task。

## Phase 3: Handle Handoff and Synthesize
---

本阶段处理 Researcher handoff、Validator Gate 和两者之间的修正往返。

注意事项：

- 正式 handoff 只按角色 Skill 的固定 contract 整理：Researcher 使用十字段格式，Validator 使用七字段格式；Coordinator 不改名、不扩写，也不把 artifact 内容拼入 task prompt。
- Researcher handoff 明确声明待人工确认的必需事实并给出最小问题时，Coordinator 可以直接向用户询问并把明确答复送回原 Researcher task；这只是对 Researcher 已声明问题的兜底转发，不得扩写或关闭领域缺口。
- Researcher handoff 只声明存在问题，但没有明确是否必须人工确认或没有给出最小问题时，先询问原 Researcher task；不得由 Coordinator 预判 Human Confirmation Gate。
- Researcher handoff 为 complete、partial 或 blocked，提供唯一可读 pack ref 且不存在待人工确认的必需事实时，才指派 Validator 检查实际内容；不得由 Coordinator 预判 Research Pack Gate。
- Researcher handoff 无唯一可读 pack ref 时，不存在可执行的 Research Pack Gate；保持 Researcher task 未归档，并报告缺少的正式输入。
- Validator 返回 `needs_fix` 或 `insufficient_evidence` 时，把 Gate ref、pack digest、问题 ids 和最小解除条件综合后发回原 Researcher task。
- Researcher 再次提交后，把同一 pack ref、新 digest 和新 handoff 发送给原 Validator task 复查；不得沿用旧 digest 的 Gate。
- Validator 返回 `blocked` 时保留两个 task，并报告当前阻塞和可恢复入口。
- Validator 返回 `accepted` 时，确认 Gate digest 对应最新 Research pack，然后归档 Researcher task 和 Validator task。
- accepted 只表示 Research pack 已通过当前 Gate；不得描述为运行验证或完整 Validation 已完成。

Exit：

- Researcher 已收到 Gate follow-up、Validator 已收到复查输入、两个 task 已在 accepted 后归档，或已形成 blocked 阶段 synthesis。

Blocked：

- Worker 结果缺少正式 pack 或 Gate ref、Gate digest 与最新 pack 不一致，或消息无法投递到原 task 时报告当前缺口。

Partial：

- Research pack 为 partial 且不存在待人工确认的必需事实时仍交给 Validator 检查；根据其 Gate 明确下一责任角色，不由 Coordinator 提升状态。

## Workflow Exit Rules (Enforcement)

- XR-001：不得从 Researcher handoff 跳过 Validator Research Pack Gate。
- XR-002：任何 Worker 报告 partial、blocked 或 evidence 不足时，不得综合成全部完成。
- XR-003：Researcher task 在 Gate accepted 前不得归档；修正和复查必须继续使用各自原 task。
- XR-004：当前阶段完成 synthesis 必须引用最新 Research pack ref、对应 digest 和 accepted Gate 报告。
- XR-005：只有最新 Research pack 的 Gate 为 `accepted` 时才能归档 Researcher 与 Validator task；缺 pack、`needs_fix`、`insufficient_evidence`、`blocked` 或 digest 不匹配均必须保留 task。
- XR-006：每次 Validator 检查必须使用其 handoff 明确引用的独立 Gate 记录；不得覆盖、复用旧 Gate 或自行猜测最高序号文件。
- XR-007：Researcher 已明确声明待人工确认的必需事实时，必须先完成该人工确认往返；不得把对应 handoff 直接派给 Validator。

## Evidence Rules (Enforcement)

- ER-001：task assigned、progress、工具调用和普通 summary 只属于 Activity State。
- ER-002：Research claim 和 Gate claim 必须分别引用 Research pack 与 Validator Gate 报告。
- ER-003：用户人工补充必须与原问题和当前 task 对齐后才能成为领域输入。
- ER-004：每个 Gate ref 只证明其 `checked_pack_digest`；同一 pack ref 内容改变后必须由新 Gate ref 记录复查结果。

## Failure Rules (Enforcement)

- FR-001：任务指派失败、Worker 不可用或消息无法投递到原 task 时，记录失败动作和当前状态。
- FR-002：结果缺少必要 refs 时不得补造；必须保留缺口并停止依赖该结果的推进。
- FR-003：Gate digest 与最新 Research pack 不一致时不得推进；必须请求原 Validator task 复查新内容。

## Blocking Rules (Enforcement)

- BR-001：缺少 BDD 定位输入时必须停止在输入阶段。
- BR-002：缺少下一角色所需正式产物时不得派发该角色；对 Validator 而言，正式产物必须是唯一可读的 Research pack 目录 ref，而不是 handoff 文本。
- BR-003：Researcher 或 Validator 已绑定不匹配的未归档 task 时不得覆盖其 runner。

## Retry Rules (Enforcement)

- RR-001：只对瞬时 task dispatch 或消息投递失败进行有限重试，并保留失败记录。
- RR-002：不得通过改变目标、Worker 角色或用户已确认输入来制造重试成功。
- RR-003：重复失败后报告阻塞，不循环派发相同 task。

## Prohibited Rules (Enforcement)

- PR-001：禁止代替 Worker 执行业务工作或补写产物。
- PR-002：禁止把未确认内容、progress 或模型推断写成领域事实。
- PR-003：禁止在缺少 BDD 定位输入时启动泛泛调查。
- PR-004：禁止把 accepted Research Gate 描述为 BDD 已验证或完整 Validation 已完成。
- PR-005：禁止使用 blocked handoff、聊天摘要、task 日志或 Coordinator synthesis 代替 Research pack 指派 Validator。

## Example

输入：

```text
用户提供 BDD ID account-anon-first-launch-signin，当前尚无 Research artifact。
```

流程：

1. 将 BDD ID、用户目标和已确认约束综合为 Researcher task。
2. 接收 Researcher 正式 handoff 和 Research artifact refs。
3. 保留 Researcher task，指派 Validator 对唯一 Research pack 形成 Research Pack Gate。
4. Gate 为 `needs_fix` 时把报告问题发回原 Researcher task；Researcher 修正后由原 Validator task 复查。
5. Gate 为 `accepted` 且 digest 对应最新 pack 时归档两个 task，并明确当前只完成 Research Gate。

输出：

- Researcher / Validator task synthesis 或 Research gate 阶段 synthesis。
- 两个 task id、Research pack ref、Gate ref、pack digest、问题 refs、限制和下一责任角色。

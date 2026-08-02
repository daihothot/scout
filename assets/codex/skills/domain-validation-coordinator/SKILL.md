---
assetKind: scout.skill
name: domain-validation-coordinator
description: Scout Coordinator 在 Validation Domain 中接收 BDD 目标，组织 Research、Verification 与两类 Validator Gate 往返，并综合当前验证状态时使用。
id: domain-validation-coordinator
version: 0.3.2
phase: [coordinate]
family: [validation, workflow, coordinator]
tags: [scout, validation, bdd, coordination, workflow]
devices: [any]
summary: 规范 Research Pack Gate、Verification 和 Verification Report Gate 的完整调度循环。
---

# Domain Validation Coordinator

当 Coordinator 运行在 Validation Domain 中，需要接收验证目标、指派 Worker 或综合验证状态时使用本技能。

本技能只定义 Validation 领域调度方法；通用 Coordinator 行为由角色 AGENT 规则定义。

## Skill Type

- type: workflow
- structure_level: full
- note: 本技能是 Coordinator 的 Validation 领域工作流，不承担 Worker 业务执行。

## Core Use

使用本技能处理：

- 判断用户输入是否具备可派发的 BDD 定位形态。
- 在 Researcher 与 Research Validator 之间维护同一 Research pack 的生产、检查和修正循环。
- 在 accepted Research Pack Gate 后指派 Verifier，并将 Verification Report 交给新的 Validator task 检查。
- 将多轮已确认用户意图综合为稳定 task prompt。
- 处理 Validation 目标的 BDD 定位补充、正式人工请求和 Worker handoff。
- 基于正式 artifact、digest 和两类 Gate 报告形成阶段或最终 synthesis。

不使用本技能处理：

- 代替 Researcher 定位 BDD 或形成 Research artifact。
- 代替 Verifier 执行验证，或代替 Validator 执行任一 artifact gate。
- 把 accepted Research Pack Gate 或 accepted Verification Report Gate 自动描述为 BDD 已验证。
- 修改代码、配置、知识库或 Worker artifact。

## Validation Coordination Model

- 当前流程状态来自 task 生命周期、正式 Human Input Request / Response、Worker 正式 handoff、artifact refs、digest 和 Validator Gate，不依赖已废弃的 schema 状态投影。
- Coordinator 只判断输入形态是否足以派发；BDD 是否真实存在、是否唯一匹配由 Researcher 确认。
- Worker progress、工具活动、普通 summary 和共享记忆不是 Validation 结论。
- Research Pack Gate 只判断 Research pack 是否可进入 Verification；Verification Report Gate 只判断报告及其 evidence 链是否完整、可定位和符合 contract。
- 只有正式人工往返、Worker 正式 handoff、artifact refs、digest 和对应 Validator Gate 可以推进当前工作流。

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

### I-005: Formal Human Input Request
---

描述：

- Runtime 明确标识、绑定当前 Worker task 的正式 Human Input Request，以及与其匹配的正式 Human Input Response。

注意事项：

- Worker handoff、artifact、partial / blocked 状态、普通消息或 Coordinator 推断不能替代正式 Human Input Request。
- 收到正式请求后按通用 Coordinator 人工输入规则转交用户；收到匹配回复前不得要求 Worker handoff，也不得启动依赖该事实的下游 task。
- handoff 声明仍有必须人工确认的事实但不存在正式请求时，该 handoff 不可消费；必须作为协议错误退回原 Worker，不得由 Coordinator 代写问题。

### I-006: Verification Handoff
---

描述：

- Verifier 正式 handoff 明确引用的 Verification Report ref、accepted Research Gate ref、Research pack ref / digest、verification point states、未覆盖范围和继续入口。

注意事项：

- Verifier 输入必须来自最新 accepted Research Pack Gate，并保持 Gate ref、pack ref 和 digest 一致。
- 普通验证摘要、progress、工具活动或未写入的 observation 不能替代 Verification Report。
- Coordinator 不重新解释 evidence 或改变 verification point state。

### I-007: Verification Report Gate
---

描述：

- 新的 Validator task 正式 handoff 明确引用的 `verification-report-gate-NNNN.md` ref、report digest、Gate、问题 ids 和未检查范围。

注意事项：

- Verification Report Gate 与 Research Pack Gate 属于两个独立 Validator task。
- Coordinator 只消费 handoff 明确引用的 Gate，不扫描 Validator artifact root 猜测最新记录。
- Gate accepted 证明报告可消费，不会把 report 中的 `insufficient_evidence`、`blocked` 或 `not_verified` 改写为 `verified`。

## Validation Coordination Workflow

- Phase 1：判断输入形态并综合稳定目标。
- Phase 2：完成 Researcher 与 Research Validator 的 Research Pack Gate 循环。
- Phase 3：完成 Verifier 与 Verification Validator 的 Verification Report Gate 循环并形成 synthesis。

## Coordinator Output Layout

本技能不创建 canonical artifact 目录。

输出形态：

- Task synthesis：已确认目标、约束、输入 refs、未确认内容，以及对应 Worker Skill 已定义的最小 handoff contract。
- BDD clarification request：最小必要问题及当前无法派发的原因。
- Worker follow-up：原问题、匹配回复、task id 和继续目标。
- Task archive decision：当前 Worker 是否仍需继续工作，以及归档所依据的正式 handoff 和当前状态。
- Research gate synthesis：Research pack ref、pack digest、Gate、问题 refs、限制和当前阶段结论。
- Verification synthesis：Verification Report ref、report digest、Verification Report Gate、逐项 verification state refs、限制和当前 Validation 结论。

### Artifact Relationship Rules

- 摘要产物：Coordinator synthesis 只汇总上游和 Worker 已确认内容，不复制业务 artifact 正文。
- 明细产物：由对应 Worker 和专项 Skill 所有。
- Registry / index：Coordinator 不创建 evidence registry，也不重新编号 evidence。
- Claim owner：Research claim 由 Researcher artifact 所有，observed claim 由 Verification Report 所有，两类 Gate claim 分别由对应 Validator Gate 报告所有。
- 下游引用规则：各 Worker task prompt 只要求对应角色 Skill 定义的固定 handoff；不得增加 artifact 摘要、证据正文或检查过程字段。
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

## Phase 2: Complete Research Pack Gate
---

本阶段根据正式 handoff 和 task 生命周期完成 Researcher 与 Research Validator 的检查往返。

注意事项：

- Researcher 接收 BDD 定位与 Research 输入收敛任务。
- Research Validator 只在 Researcher 已提交正式 handoff，且 handoff 明确引用唯一、可读的 Research pack 目录后接收 Research Pack Gate task。
- Coordinator 的 assignment prompt 必须原样引用对应 Worker Skill 的固定 handoff 字段，不得要求 Researcher 返回证据摘要、关键结论、源码细节或 artifact 清单，也不得要求 Validator 返回 Checked Refs、检查过程、源码定位或问题正文。
- 当前 Researcher task 存在 unresolved 正式 Human Input Request 时，先完成正式人工往返；不得要求 handoff，也不得创建或继续 Research Validator task。
- Researcher handoff 声明仍有必须人工确认的事实但没有 unresolved 正式 Human Input Request 时，该 handoff 属于协议错误；退回原 Researcher task 应用 Human Confirmation Gate，不得由 Coordinator 直接询问用户。
- Researcher handoff 缺少唯一可读 pack ref 时，保留原 Researcher task；不得把 handoff 文本包装成 Validator 输入，也不得创建 Validator task。
- Researcher task 进入 `done` 后保持未归档，直到 Validator 对对应 pack digest 给出 `accepted`。
- Research Validator 已有未归档 task 时，通过同一 task 继续复查，不创建新的 Research Validator task。
- 代码实现、重构、产品方案或无 BDD 目标的能力探查不得作为本工作流中的 Research Pack Gate 任务派发。

派发顺序：

1. 没有 Researcher 正式 handoff：保留 Researcher task，等待其继续工作或正式交回。
2. 当前 task 存在 unresolved 正式 Human Input Request：转交用户并等待匹配回复；不要求 handoff，不向 Validator 派发。
3. handoff 声明仍有必须人工确认的事实但不存在正式请求：拒绝消费该 handoff，要求原 Researcher 在同一 task 应用 Human Confirmation Gate。
4. 有 handoff 但没有唯一可读 Research pack 目录 ref：保留 Researcher task，停止向 Validator 派发。
5. 有唯一可读 Research pack 目录 ref，且不存在 unresolved 正式 Human Input Request：保留 Researcher task，创建或继续 Research Validator task 检查该 pack。
6. Gate 为 `needs_fix` 或 `insufficient_evidence`：保留两个 task，把 Gate ref 和问题 ids 发回原 Researcher task。
7. Gate 为 `blocked`：保留两个 task，不归档、不改派其它角色。
8. Gate 为 `accepted` 且 digest 对应最新 pack：归档 Researcher 与 Research Validator task，进入 Phase 3。

Exit：

- Researcher 或 Research Validator 已接收包含完整 refs 和预期 handoff 的 task，或 accepted Research Pack Gate 已允许进入 Phase 3。

Blocked：

- 必要输入缺失、目标 Worker 已绑定其它未归档 task、正式人工请求未解决或 task 指派失败时停止派发。

Partial：

- 已有部分 Worker 结果但不满足下一角色输入时，整理为状态说明，不伪造后续 task。

## Phase 3: Complete Verification Report Gate
---

本阶段以 accepted Research Pack Gate 为唯一入口，完成 Verifier 与新的 Verification Validator task 的报告检查往返。

注意事项：

- Verifier task 输入必须明确包含 accepted Research Gate ref、唯一 Research pack ref、对应 digest 和 verification manual ref；缺一不得派发。
- Verifier 正式 handoff 只使用 `domain-validation-verifier` 定义的固定字段；Coordinator 不复制 report 正文、observation 或 evidence 内容。
- 当前 Verifier task 存在 unresolved 正式 Human Input Request 时，先完成正式人工往返；不得要求 handoff，也不得创建 Verification Validator task。
- Verifier handoff 声明仍有必须人工确认的事实但没有 unresolved 正式 Human Input Request 时，按协议错误退回原 Verifier task。
- Verifier 正式提交 Verification Report 后，必须创建新的 Validator task；不得恢复或复用已经完成 Research Pack Gate 的 Validator task。
- Verification Validator 返回 `needs_fix` 或 `insufficient_evidence` 时，保留 Verifier 与当前 Verification Validator task，把 Gate ref 和问题 ids 发回原 Verifier task。
- Verifier 修正同一 `verification-report.md` 后，由原 Verification Validator task 创建下一份不可变 Gate 记录；不得修改旧 Gate。
- Verification Validator 返回 `blocked` 时保留两个 task，并报告当前阻塞和可恢复入口。
- Verification Validator 返回 `accepted` 时，确认 Gate digest 对应当前 report，归档 Verifier 与 Verification Validator task，并按 report 中每个 verification point 的原状态形成 synthesis。
- accepted Verification Report Gate 只表示报告及 evidence 链通过检查；不得把其中的 `not_verified`、`insufficient_evidence` 或 `blocked` 提升为 `verified`。

Exit：

- Verifier 已收到 Gate follow-up、Verification Validator 已收到复查输入、两个 task 已在 accepted 后归档，或已形成 blocked 阶段 synthesis。

Blocked：

- accepted Research Gate、Verification Report 或 Gate ref 缺失，digest 与当前 artifact 不一致，或消息无法投递到原 task 时报告当前缺口。

Partial：

- Verification Report 可以包含多个不同 verification point state；Coordinator 保留其逐项状态，不用总体自然语言覆盖未完成范围。

## Workflow Exit Rules (Enforcement)

- XR-001：不得从 Researcher handoff 跳过 Validator Research Pack Gate。
- XR-002：任何 Worker 报告 partial、blocked 或 evidence 不足时，不得综合成全部完成。
- XR-003：Researcher task 在 Gate accepted 前不得归档；修正和复查必须继续使用各自原 task。
- XR-004：没有最新 accepted Research Pack Gate、唯一 pack ref 和对应 digest 时，不得创建 Verifier task。
- XR-005：Research Pack Gate 与 Verification Report Gate 必须使用两个独立 Validator task；不得复用、重开或改写前一个 task 的职责。
- XR-006：每次 Validator 检查必须使用其 handoff 明确引用的独立 Gate 记录；不得覆盖、复用旧 Gate 或自行猜测最高序号文件。
- XR-007：只有 Runtime 标识的正式 Human Input Request 才能启动 Worker 人工往返；handoff 中的人工问题声明只能作为协议错误退回原 Worker。
- XR-008：最终 Validation synthesis 必须引用 accepted Research Pack Gate、Verification Report 和 accepted Verification Report Gate。
- XR-009：accepted Verification Report Gate 不改变 Verification Report 中任何 verification point state。

## Evidence Rules (Enforcement)

- ER-001：task assigned、progress、工具调用和普通 summary 只属于 Activity State。
- ER-002：Research claim、observed claim 和 Gate claim 必须分别引用 Research pack、Verification Report 与对应 Validator Gate 报告。
- ER-003：用户人工补充必须与原问题和当前 task 对齐后才能成为领域输入。
- ER-004：每个 Gate ref 只证明其 `checked_pack_digest`；同一 pack ref 内容改变后必须由新 Gate ref 记录复查结果。
- ER-005：Verification Report Gate 只证明其 `checked_report_digest`；report 内容改变后旧 Gate 不再适用。

## Failure Rules (Enforcement)

- FR-001：任务指派失败、Worker 不可用或消息无法投递到原 task 时，记录失败动作和当前状态。
- FR-002：结果缺少必要 refs 时不得补造；必须保留缺口并停止依赖该结果的推进。
- FR-003：Gate digest 与最新 Research pack 不一致时不得推进；必须请求原 Validator task 复查新内容。
- FR-004：Worker handoff 绕过正式 Human Input Request 携带待人工确认问题时，不得转问用户或继续下游；必须退回同一 Worker task。

## Blocking Rules (Enforcement)

- BR-001：缺少 BDD 定位输入时必须停止在输入阶段。
- BR-002：缺少下一角色所需正式产物时不得派发该角色；Research Validator 需要唯一 Research pack，Verifier 需要 accepted Research Gate，Verification Validator 需要正式 Verification Report。
- BR-003：Researcher、Verifier 或 Validator 已绑定不匹配的未归档 task 时不得覆盖其 runner。

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
- PR-006：禁止复用 Research Validator task 检查 Verification Report。
- PR-007：禁止从 Worker handoff 自行构造正式人工请求。

## Example

输入：

```text
用户提供 BDD ID account-anon-first-launch-signin，当前尚无 Research artifact。
```

流程：

1. 将 BDD ID、用户目标和已确认约束综合为 Researcher task。
2. 接收 Researcher 正式 handoff 和 Research artifact refs。
3. 保留 Researcher task，指派 Research Validator 对唯一 Research pack 形成 Research Pack Gate。
4. Gate 为 `needs_fix` 时把报告问题发回原 Researcher task；Researcher 修正后由原 Validator task 复查。
5. Gate 为 `accepted` 且 digest 对应最新 pack 时归档两个 task，创建 Verifier task。
6. Verifier 提交 Verification Report 后创建新的 Verification Validator task。
7. Verification Report Gate accepted 后按 report 中每个 verification point 的原状态形成最终 synthesis。

输出：

- Worker task synthesis、Research gate 阶段 synthesis 或最终 Validation synthesis。
- 相关 task ids、artifact refs、Gate refs、digests、verification point states、问题 refs、限制和下一责任角色。

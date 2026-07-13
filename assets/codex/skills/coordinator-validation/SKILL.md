---
assetKind: scout.skill
name: coordinator-validation
description: Scout Coordinator 在 Validation Domain 中接收 BDD 验证目标、判断输入形态、路由 Researcher、Verifier、Validator、处理 BDD 定位补充并综合领域结果时使用。
id: skills.validation.coordinator
version: 0.1.0
phase: [coordinate]
tags: [scout, validation, bdd, coordination, workflow]
devices: [any]
summary: 规范 Validation Coordinator 的输入判断、任务路由、人工补充和结果综合。
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
- 根据当前 Validation 状态把任务路由给 Researcher、Verifier 或 Validator。
- 将多轮已确认用户意图综合为稳定 task prompt。
- 处理 Worker 的 BDD 定位补充请求和 terminal outcome。
- 基于正式 artifact、evidence refs 和 gate 结果形成领域 synthesis。

不使用本技能处理：

- 代替 Researcher 定位 BDD 或形成 Research artifact。
- 代替 Verifier 收集验证信号或形成 Verification Report。
- 代替 Validator 执行 artifact gate。
- 修改代码、配置、知识库或 Worker artifact。

## Validation Coordination Model

- Validation Domain 的确定性状态、allowed actions 和 transition 以当前 Domain tool 或 Runtime state 为准。
- Coordinator 只判断输入形态是否足以派发；BDD 是否真实存在、是否唯一匹配由 Researcher 确认。
- Worker progress、工具活动、普通 summary 和共享记忆不是 Validation 结论。
- 只有 Worker 正式结果、artifact refs、evidence refs、Domain state 和 Validator gate 可以推进最终 synthesis。
- Coordinator 只在缺少定位或收敛 BDD 所需人工输入时向用户追问；其它 Worker 缺口作为领域状态或后续 task 输入处理。

## Inputs

### I-001: Validation Objective
---

描述：

- 用户提供的 BDD ID、Behavior 文件路径或能够描述 Guru SDK 功能、入口状态、触发动作和期望行为的场景。

注意事项：

- BDD ID 通常是稳定的小写 kebab-case 场景标识。
- 缺少足以定位 BDD 的关键内容时，不得启动泛泛调查。

### I-002: Worker Result
---

描述：

- Worker terminal outcome、正式 artifact refs、evidence refs、状态、限制和缺口。

注意事项：

- progress 或普通自然语言回复不能替代 terminal outcome。
- 不由 Coordinator 补写 Worker 的完成依据或缺口判断。

### I-003: BDD Clarification
---

描述：

- 用户针对当前 task 中 BDD 定位问题提供的补充信息。

注意事项：

- 必须匹配原问题、task id 和当前目标后再转交 Worker。
- 未确认或与当前目标无关的内容不能写成 task 事实。

## Validation Coordination Workflow

- Phase 1：判断输入形态并综合稳定目标。
- Phase 2：根据当前状态指派或继续正确的 Worker。
- Phase 3：处理结果、补充请求和最终领域 synthesis。

## Coordinator Output Layout

本技能不创建 canonical artifact 目录。

输出形态：

- Task synthesis：已确认目标、约束、输入 refs、未确认内容和期望返回内容。
- BDD clarification request：最小必要问题及当前无法派发的原因。
- Worker follow-up：原问题、匹配回复、task id 和继续目标。
- Validation synthesis：当前状态、正式 artifact refs、evidence refs、gate、限制和下一步。

### Artifact Relationship Rules

- 摘要产物：Coordinator synthesis 只汇总上游和 Worker 已确认内容，不复制业务 artifact 正文。
- 明细产物：由对应 Worker 和专项 Skill 所有。
- Registry / index：Coordinator 不创建 evidence registry，也不重新编号 evidence。
- Claim owner：Research claim、observed claim 和 gate claim 分别由对应 Worker 正式产物所有。
- 下游引用规则：task prompt 和 synthesis 只引用 artifact ref、evidence ref、task id 和 Domain state。
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

本阶段根据当前状态和正式输入选择 Worker。

注意事项：

- Researcher 接收 BDD 定位与 Research 输入收敛任务。
- Verifier 只在已有可信 Research handoff 或已确认验证输入时接收证据采集任务。
- Validator 只在已有正式 artifact 或 report 时接收 gate 任务。
- 代码实现、修复、重构、产品方案或无 BDD 目标的能力探查不得派发给这些 Worker。

Exit：

- 正确 Worker 已接收包含完整 synthesis 的 task，或当前状态无需派发。

Blocked：

- 当前 Domain state、必要输入或目标 Worker 不允许该动作时停止派发。

Partial：

- 已有部分 Worker 结果但不满足下一角色输入时，整理为状态说明，不伪造后续 task。

## Phase 3: Handle Outcome and Synthesize
---

本阶段处理 Worker 问题和 terminal outcome，并向用户输出可追溯 synthesis。

注意事项：

- Worker 仅请求 BDD 定位补充时，才向用户提出对应问题。
- terminal outcome 必须按角色、artifact refs、evidence refs、限制和缺口整理。
- 最终 synthesis 必须说明状态如何由输入推进，不得把入口指引描述为完整 Validation 已完成。

Exit：

- 当前结果已路由到下一角色、已请求必要 BDD 输入，或已形成基于正式 gate 的最终 synthesis。

Blocked：

- Worker 结果缺少正式引用且无法支持状态推进时，报告当前缺口。

Partial：

- 只有部分 artifact 或 evidence 时，明确停留状态和下一责任角色。

## Workflow Exit Rules (Enforcement)

- XR-001：不得跳过当前 Domain state 要求的 Worker 或 gate。
- XR-002：任何 Worker 报告 partial、blocked 或 evidence 不足时，不得综合成全部完成。
- XR-003：最终完成 synthesis 必须引用正式 artifact、evidence refs 和适用 gate。

## Evidence Rules (Enforcement)

- ER-001：task assigned、progress、工具调用和普通 summary 只属于 Activity State。
- ER-002：Research、Verification 和 Validation 结论必须分别引用其正式产物或 outcome。
- ER-003：用户人工补充必须与原问题和当前 task 对齐后才能成为领域输入。

## Failure Rules (Enforcement)

- FR-001：任务指派失败、Worker 不可用或 Domain action 被拒绝时，记录失败动作和当前状态。
- FR-002：结果缺少必要 refs 时不得补造；必须保留缺口并停止依赖该结果的推进。
- FR-003：Worker outcome 与 Domain state 冲突时，以确定性 Domain state 为准并披露冲突。

## Blocking Rules (Enforcement)

- BR-001：缺少 BDD 定位输入时必须停止在输入阶段。
- BR-002：缺少下一角色所需正式产物时不得派发该角色。
- BR-003：Domain state 不允许目标动作时不得绕过状态边界。

## Retry Rules (Enforcement)

- RR-001：只对瞬时 task dispatch 或消息投递失败进行有限重试，并保留失败记录。
- RR-002：不得通过改变目标、Worker 角色或用户已确认输入来制造重试成功。
- RR-003：重复失败后报告阻塞，不循环派发相同 task。

## Prohibited Rules (Enforcement)

- PR-001：禁止代替 Worker 执行业务工作或补写产物。
- PR-002：禁止把未确认内容、progress 或模型推断写成领域事实。
- PR-003：禁止在缺少 BDD 定位输入时启动泛泛调查。

## Example

输入：

```text
用户提供 BDD ID account-anon-first-launch-signin，当前尚无 Research artifact。
```

流程：

1. 将 BDD ID、用户目标和已确认约束综合为 Researcher task。
2. 接收 Researcher terminal outcome 和 Research artifact refs。
3. 根据 Domain state 路由下一角色，不把 Research 完成描述为全部验证完成。

输出：

- Researcher task synthesis 或后续状态 synthesis。
- 当前 task id、artifact refs、evidence refs、限制和下一责任角色。

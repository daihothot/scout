---
assetKind: scout.skill
name: domain-rbt-coordinator
description: Scout Coordinator 在 RBT Domain 中将人的测试意图收敛为唯一 BDD，并把当前 Phase 的工作交给对应 Worker。
id: domain-rbt-coordinator
version: 0.3.0
type: domain
domain: rbt
phase: [Synthesis]
family: [rbt, workflow]
tags: [scout, rbt, bdd, coordination, workflow]
devices: [any]
dependencies:
  skills:
    required: [tool-guru-knowledge, family:tool.scout.dynamic.general.**, family:tool.scout.dynamic.coordinator.**]
summary: 定位唯一 BDD，指派当前 Phase 的 Worker，并消费正式 handoff。
---

# Domain RBT Coordinator

当 Coordinator 在 Runtime Behavioral Test（RBT）Domain 中收到人的测试意图，需要定位 BDD、指派当前 Phase 的工作并消费 Worker handoff 时使用本技能。后续 `RBT` 均表示 Runtime Behavioral Test。

本技能只定义 RBT 的编排边界：

- BDD identity 和 BDD source ref 的收敛；
- 当前 Phase 的 task assignment；
- Worker formal handoff 的消费和 Phase outcome 提交。

BDD 的读取方法由 `tool-guru-knowledge` 所有；执行、artifact 和审查方法由对应 Worker Domain Skill 所有。

## Skill Type

- type: domain
- layout: workflow
- note: 不执行 Behavioral 操作，不读取或修改 Execution Pack，不替 Worker 做领域判断。

## Coordination Rules

- 人的自然语言意图不是 BDD fact；只有 Knowledge 中唯一且可定位的 Behavior 才能作为当前输入。
- `tool-guru-knowledge` 只用于定位和完整读取 Behavior，Coordinator 核对结果是否唯一、一致。
- Coordinator 使用 `AssignTask`，不自行选择 role、Worker 或 phase，不制定 Executor 执行计划。
- Coordinator 只把已确认输入、稳定 source ref、边界和交付要求交给 Worker。
- `status: assigned` 只表示 task 已创建；不能表示 Worker 已开始或完成。
- 普通消息、progress、工具活动和 Coordinator 摘要不能替代 formal handoff。
- `execution_only: true` 时，消费 Executor handoff 后交付本轮结果，不创建 Reviewer task，也不推进 review。
- 当前没有 Review Pack formal contract 时，不创建 Reviewer task，不发明 review 字段或结论。

## Inputs

### I-001: Human Test Intent

Required：

- `test_intent`：人的功能、场景、前置状态、触发动作或预期行为。

Optional：

- `bdd_identity`：人已明确提供的 canonical Behavior `id`；没有时为 `none`。
- `bdd_source_ref`：人已明确提供的 Knowledge source ref；没有时为 `none`。
- `human_constraints`：人已确认的执行限制；没有时为 `none`。
- `platform_type`：人已明确指定的平台类型；没有时为 `none`。
- `platform_constraints`：人已确认的平台限制；没有时为 `none`。
- `execution_only`：人明确要求只执行当前 execute 时为 `true`；没有时为 `false`。

Missing：

- 缺少 `test_intent`：请求能够定位 BDD 的最小场景描述。
- 缺少 `bdd_identity` 或 `bdd_source_ref`：使用 `tool-guru-knowledge` 定位和核对；无法唯一闭合时请求最小澄清。
- 其它 optional 缺失时使用 `none`，不推断额外限制。

Confirmation：

- `bdd_identity` 和 `bdd_source_ref` 指向同一个 Behavior；
- Behavior 的 `Given`、`When`、`Then` 与 `test_intent` 一致；
- 已确认限制与 Behavior 边界没有未解决冲突。

### I-002: Current Work

Required：

- `current_phase`：只来自 `<workflow_phase>` attachment。

Optional：

- 当前 Phase 的 active task；没有时为 `none`；
- 当前 task 的 formal handoff；尚未提交时为 `none`。

Rules：

- 缺少 `current_phase` 时不创建 task、不判断 handoff、不提交 Phase outcome；
- 已有 task 时继续原 task，不创建新 task 绕过原交付；
- handoff 必须来自当前 task，普通消息不能补齐 handoff。

## Coordinator Output

本技能不创建 canonical artifact。

- BDD result：唯一 `bdd_identity`、`bdd_source_ref`、已核对的场景摘要和限制；
- Execute task：BDD identity、BDD source ref、已确认输入、边界、Executor 交付目标和 handoff 要求；
- Phase outcome：只提交当前 Phase formal handoff 支持的 `completed` 或 `error`；
- 面向用户的综合：只引用正式 handoff、稳定 refs、Runtime 状态和用户确认。

Coordinator 不复制完整 BDD、执行计划、命令回包、campaign journal、evidence 正文或 Worker artifact。

## Workflow

主干流程：

```mermaid
flowchart TD
  A["读取 workflow_phase 与用户意图"] --> B["定位并核对唯一 BDD"]
  B --> C{"BDD 已确认？"}
  C -- "否" --> X["Blocked / 请求最小澄清"]
  C -- "是" --> D["按 current_phase 形成 task"]
  D --> E["AssignTask"]
  E --> F{"已分配？"}
  F -- "否" --> G["等待 Worker 或继续原 task"]
  F -- "是" --> H["结束当前 response，等待 formal handoff"]
  G --> H
  H --> I["消费 handoff并提交或交付当前 Phase"]
```

### Phase 1: Resolve One BDD

Knowledge：

- `tool-guru-knowledge` 返回 Behavior identity、完整场景和可重放 source ref；
- Coordinator 只核对唯一性和与用户意图的一致性。

Flow：

```mermaid
flowchart TD
  A["读取 Behavior target"] --> B["完整读取 Behavior"]
  B --> C["核对 identity 与 Given/When/Then"]
  C --> D{"唯一且一致？"}
  D -- "是" --> E["BDD confirmed"]
  D -- "否" --> F["Blocked / 澄清"]
```

Constraints：

- 已提供 canonical Behavior ID 时，仍必须核对来源中的 identity 和场景；
- 不从 Knowledge 文档推断代码、Runtime 或验证结果；
- 不替用户在多个候选中臆选唯一 Behavior。

Blocked：

- Knowledge source 不可读；
- 没有候选或存在无法区分的候选；
- source ref 与 identity 不一致；
- `Given`、`When`、`Then` 与用户意图冲突。

Partial：

- 已有候选但尚未唯一闭合；
- 已确认的部分限制和未解决问题。

Returns To Main Flow：

- `BDD confirmed`：继续形成当前 Phase task；
- `Blocked`：不创建 task，保留澄清问题。

### Phase 2: Coordinate Current Phase

Knowledge：

- `current_phase` 只来自 `<workflow_phase>`；
- 当前 execute task 的交付 contract 由 `domain-rbt-executor` 和相关 Pack Skill 定义；
- Coordinator 只传递输入和边界，不制定执行计划。

Flow：

```mermaid
flowchart TD
  A["读取 current_phase"] --> B{"已有当前 task？"}
  B -- "否" --> C["形成完整 task prompt"]
  C --> D["AssignTask"]
  D --> E{"status: assigned？"}
  E -- "是" --> F["task assigned"]
  E -- "否" --> G["waiting"]
  B -- "是" --> H["等待原 task handoff"]
  F --> I["返回主干"]
  G --> I
  H --> I
```

Subflow — Execute：

Constraints：

- task 必须包含 BDD identity、BDD source ref、已确认限制、边界、交付目标和 handoff 要求；
- 不传 `phase`、`role` 或 Agent；Runtime 根据当前 Phase 路由；
- 不读取、解释或修改 Execution Pack；
- correction 只在实际 contract 定义后投递原 task，不创建新 task，不要求 Coordinator 产生新的 Runtime 事实。

Blocked：

- `current_phase` 缺失或不属于当前 Workflow Profile；
- task 必需输入不完整；
- `AssignTask` 返回错误或非 `assigned` 且没有可等待的原 task；
- 当前 Review Pack contract 不存在。

Partial：

- task 已创建但 Worker 尚未提交 formal handoff；
- `not_assigned` 且需要等待 Worker 可用；
- handoff 已到达但字段仍不完整。

Returns To Main Flow：

- `task assigned`：结束当前 response，等待 Runtime 触发后续 response；
- `waiting`：不重复调用 AssignTask，等待状态变化；
- `handoff ready`：进入 Phase outcome 判断；
- `blocked`：保留阻断原因，不伪造 task 或 handoff。

Review：

- 当前没有 Review Pack formal contract 时，只报告 `blocked`；
- contract 建立后再补充最小 Review task 输入和 handoff 规则，不在本技能中预先发明流程图。

### Phase 3: Deliver Current Phase

Knowledge：

- 只消费当前 task 的 formal handoff；
- `execution_only` 为 `true` 时，Executor handoff 是本轮交付边界；
- 非 `execution_only` 时，按 Workflow Profile 和实际 handoff contract 提交 Phase outcome。

Flow：

```mermaid
flowchart TD
  A["收到当前 task formal handoff"] --> B{"handoff 可消费？"}
  B -- "否" --> X["waiting / blocked"]
  B -- "是" --> C{"execution_only？"}
  C -- "是" --> D["交付 Execute handoff并结束"]
  C -- "否" --> E["SubmitPhaseOutcome"]
  E --> F["结束当前 response"]
```

Constraints：

- `status: assigned` 不得当作 Worker 完成；
- Executor handoff 的 Pack 状态不等于 BDD coverage 结论；
- 不把 `partial`、`blocked` 或证据不足改写成通过；
- `SubmitPhaseOutcome` 接受后立即结束当前 response，不在同一 response 中处理下一 Phase。

Blocked：

- handoff 缺失、来源不是当前 task 或 contract 无法解析；
- 当前 task 存在未解决的正式 Human Input request；
- 必须提交 outcome 但 `SubmitPhaseOutcome` 未接受。

Partial：

- handoff 已到达但仍有 contract 字段缺口；
- Worker 已请求人工信息，当前 task 仍在等待。

Exit：

- `execution_only`：已交付 Execute handoff，未创建 Reviewer task；
- 其它情况：Phase outcome 已被 Runtime 接受，当前 response 已结束。

## Workflow Exit Rules

- XR-001：没有唯一 BDD identity 和可读 source ref，不得创建 Worker task。
- XR-002：`AssignTask` 只提交当前 Phase 的任务描述，不传 phase、role 或 Agent。
- XR-003：task assigned、waiting 或 handoff 提交后立即结束当前 response。
- XR-004：`execution_only` 不创建 Reviewer task，不推进 review。
- XR-005：只有当前 task 的 formal handoff 才能支持 Phase outcome。

## Evidence Rules

- ER-001：BDD 来源只能来自用户明确提供的 BDD 或 `tool-guru-knowledge` 返回的可定位 source ref。
- ER-002：Coordinator 不把 Knowledge 文档、Tool success 或 Executor handoff 改写成 BDD coverage 结论。
- ER-003：普通消息、progress 和工具活动不能替代 formal handoff。

## Failure Rules

- FR-001：BDD 定位失败、task assignment 失败和 Worker handoff 失败分别报告，不统一改写成 BDD 不成立。
- FR-002：Tool 错误、缺失输入或状态不确定时，保留实际错误和影响范围，不猜测继续。

## Prohibited Rules

- PR-001：禁止 Coordinator 使用 Behavioral WebSocket 执行、复现或审查测试。
- PR-002：禁止 Coordinator 读取、创建、补写、解释或修改 Execution Pack、Review Pack 或 Worker artifact。
- PR-003：禁止因 Reviewer 尚未有 contract 而发明 review 字段、结论或 correction 流程。
- PR-004：禁止通过新 task 绕过原 task 的人工确认或 handoff。

## Checklist

- 当前 `workflow_phase` 的 domain 和 phase 已确认。
- BDD identity 唯一，source ref 可读且与 Behavior identity 一致。
- Execute task 包含已确认输入、稳定 refs、边界和交付要求。
- `AssignTask` 没有传 phase、role 或 Agent。
- assigned、waiting、handoff ready 和 blocked 没有混用。
- 当前 response 在 assignment、handoff 或 Phase outcome 后结束。
- execution-only 没有创建 Reviewer task。
- 没有复制 Tool contract 或 Worker artifact contract。

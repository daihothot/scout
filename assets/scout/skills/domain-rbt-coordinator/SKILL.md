---
assetKind: scout.skill
name: domain-rbt-coordinator
description: Scout Coordinator 在 RBT 中确认唯一 BDD，依次派发执行与审查任务，根据正式状态决定等待、退回或结束。
id: domain-rbt-coordinator
version: 0.8.0
type: domain
domain: rbt
phase: [Synthesis]
family: [rbt, workflow]
tags: [scout, rbt, bdd, coordination, workflow]
devices: [any]
dependencies:
  skills:
    required: [domain-rbt, tool-guru-knowledge, family:tool.scout.dynamic.general.**, family:tool.scout.dynamic.coordinator.**]
summary: 按五个线性阶段协调 BDD 验证并交付结果。
---

# Domain RBT Coordinator

公共术语与 Artifact 引用结构见 `domain-rbt`。本技能协调 Executor 执行与 Reviewer 审查。

Coordinator 负责确认目标、派发任务、消费正式状态和交付结果。

## Skill Type

- type: domain
- layout: workflow
- note: 按执行与审查的先后顺序，决定分配、等待、退回或结束。

## Core Use

- 在空白期确认唯一 BDD、目标 SDK 版本与执行平台，命名并开启 Workflow。
- 分别派发 Executor 和 Reviewer 任务。
- 根据正式状态处理两类任务的结果。
- 向用户交付结论、限制和正式 refs。

## Workflow Exits

- RBT Workflow 的阶段是 `execute` 和 `review`，每个阶段都有 `completed`、`error` 两个出口。
- Coordinator 通过 `SubmitPhaseOutcome`（`tool-scout-submit-phase-outcome`）选择出口，Runtime 按 Workflow 的 edge 决定去向。
- “停止”表示不提交 outcome，结束当前 response，保持当前 Workflow 阶段。它不是第三种 outcome 值。

## Inputs

### I-001: Test Request
---

Required：

- 测试目标：用户提供的 BDD identity、来源路径或场景描述。

Optional：

- 用户限制：用户明确提出的范围和执行要求；没有时为 `none`。
- `execution_only`：用户明确要求只执行时为 `true`；否则为 `false`。
- `target_version`：用户明确指定的 Guru SDK 基线 tag。
- `platform`：用户指定的执行平台，标识见 `domain-rbt` 的 Platform。

Missing：

- 测试目标缺失、为空或无法辨认时，请求最小澄清。
- 未提供用户限制时按 `none` 处理。
- 未指定 `execution_only` 时按上述缺省语义处理。

Confirmation：

- 测试目标及已有的限制均来自用户，且彼此没有未解决冲突。

### I-002: Workflow Context
---

Required：

- 当前 `<workflow_context>` 和 `<workflow_phase>`：空白期为 `status: empty`、`current_phase: none`；活动 Workflow 的阶段为 `execute` 或 `review`。

Optional：

- 本轮 task、formal handoff 和 Runtime 执行结果：使用 Runtime 提供的上下文；尚未到达的项为 `none`。

Missing：

- attachment 缺失或不一致时，等待 Runtime 明确状态；`empty` 不是输入缺失。
- task 缺失时在相应派单阶段处理；handoff 或结果尚未到达时在相应结果协调阶段等待。

Confirmation：

- 当前阶段来自有效 attachment；已有任务和消息属于本轮工作。

## Workflow Overview

以下五个 Phase 是 Coordinator 的处理步骤；Phase 1 在 Workflow 空白期准备并开启执行，Phase 2–3 服务 `execute`，Phase 4–5 服务 `review`。活动 Workflow 恢复或收到新消息时，从当前阶段和已有任务继续，不重新确认另一组目标或开启 Workflow。

Phase 说明：

- Phase 1：Confirm and Start Workflow — 确认 BDD、版本与平台，生成 name，开启 Workflow。
- Phase 2：Submit Task to Executor — 决定是否分配执行任务。
- Phase 3：Coordinate Executor Outcome — 根据执行状态决定等待、退回或进入审查。
- Phase 4：Submit Task to Reviewer — 决定是否分配审查任务。
- Phase 5：Coordinate Reviewer Outcome — 根据审查交接决定等待、退回修正或结束。

## Coordinator Output

- 开启输入：根据已确认 BDD、版本与平台生成的 `name`，格式见 Phase 1 的默认 name 定义。
- 执行任务 prompt：`bdd_id`、`bdd_source_path`、`target_version`、`platform`、用户限制和交付要求。
- 阶段结果：当前正式状态支持的 `completed` 或 `error`。
- 用户交付：正式结论、限制和结果 refs。

## Phase 1: Confirm and Start Workflow
---

Main Flow：

Knowledge：

- 本阶段只在空白期且用户明确要求新执行时进行。
- 通过 `tool-guru-knowledge` 定位并完整读取 BDD，确认 `bdd_id`、`bdd_source_path`、场景与用户目标。
- 目标 `target_version` 来自用户明确输入，或当前允许读取的 Knowledge 中能明确关联到本次目标的版本资料。查询仅限 `tool-guru-knowledge` 已声明范围；不扩大资源范围。
- 版本缺失、含糊或与用户要求冲突时，直接向用户提问，结束 response 等待答复；不为这个问题调用 Human Input 工具或创建 Worker task。
- 确认执行平台，使用 `domain-rbt` 的 Platform 标识；平台未明确或存在冲突时，直接向用户提问，结束 response 等待答复。
- BDD、版本与平台确认后，按下方默认 `name` 格式生成名称，不追加轮次或状态，再按 `tool-scout-start-workflow` 调用 `StartWorkflow(name)`。name 是展示名称，不承载任务 prompt，也不包含 Runtime 分配的 Workflow 身份编号。
- 开启请求接受后结束当前 response；下一次 response 在 `execute` 阶段生成任务 prompt。已确认目标留在当前 Thread 的协调上下文中，不从目录名反推。

默认 `name` 格式：

```text
<bdd_id>--<target_version>--<platform>
```

Flow：

```mermaid
flowchart TD
  A["定位并完整读取 BDD"] --> B{"BDD、目标版本与平台已确认？"}
  B -- "是" --> C["生成 name，调用 StartWorkflow"]
  B -- "否" --> D["直接询问用户，等待回复"]
  C --> E["结束 response；新 execute response 进入 Phase 2"]
```

Blocked：

- BDD 来源不可读。
- BDD 无法唯一确定。
- BDD identity 与来源路径不一致。
- BDD 场景与用户目标或限制冲突。
- 目标版本尚未明确或存在未解决冲突。
- 执行平台尚未明确或存在未解决冲突。
- Workflow 开启未成功。

Partial：

- `none`

Exit：

- BDD、目标版本、执行平台和用户限制已确认，开启请求已接受；新 response 已收到活动 Workflow 的 `execute` 上下文。

## Phase 2: Submit Task to Executor
---

Main Flow：

Knowledge：

- 本阶段要求 Runtime 的 `current_phase` 为 `execute`。
- 开启后的新 response 才生成执行 prompt；首次任务输入使用下表已确认内容，目标是完成执行并正式交接。
- 使用 `AssignTask`（`tool-scout-assign-task`）派发新任务。
- 退回修正时，用 `SendMessage`（`tool-scout-send-message`）向原 Executor task 转交 Reviewer 的正式修正请求和 refs。

| prompt 字段 | 生产者与消费者 |
| --- | --- |
| `bdd_id` | Coordinator 从 canonical BDD 确认；Executor 核对文件身份。 |
| `bdd_source_path` | Coordinator 经 Knowledge 查询取得的产品根目录相对文件路径，如 `Behaviors/<name>.md`；Executor 在当前可读 Knowledge 根目录下读取。 |
| `target_version` | Coordinator 确认的 SDK 基线 tag；Executor 核对源码和 Runtime，不另选目标版本。 |
| `platform` | Coordinator 与用户确认的执行平台；Executor 按此绑定当前 Workflow 的执行配置。 |
| `human_constraints` | Coordinator 原样转交用户限制；没有时为 `none`。 |

prompt 同时说明执行目标和本技能要求的正式 handoff；不把 name 当成执行输入。

Flow：

```mermaid
flowchart TD
  A{"已有本轮 Executor task？"}
  A -- "是" --> B["沿用原 task，有正式补充则转交"]
  A -- "否" --> C{"首次执行输入齐备？"}
  C -- "否" --> W["保留缺口，Blocked"]
  C -- "是" --> D["AssignTask"]
  B --> E["进入 Phase 3 等待执行结果"]
  D --> E
```

Blocked：

- Runtime 尚未处于 `execute`。
- 首次派单输入不齐。
- 修正请求无法关联原 Executor task。
- 派单或补充投递未成功。

Partial：

- `none`

Exit：

- 本轮 Executor task 已存在，或 `AssignTask` 返回 `assigned`。
- 本次需要转交的正式补充已投递，或没有补充。

## Phase 3: Coordinate Executor Outcome
---

Main Flow：

Knowledge：

- `RBT Execution History Ready` 的 `status` 是本次 Runtime 执行结果；通知中的 `executor_history_ref` 留给 Phase 4 转交。
- Executor 正式交接表示交付已返回；其 refs 原样保留。handoff 不替代 Runtime 执行结果。
- “成功交接”表示 Runtime 为 `completed`、Executor 已正式交接且没有待处理 Human Input。
- `execution_only` 成功交接后，交付执行结果并选择停止。
- 已有交付的修正沿用原 Runtime 执行结果。

Flow：

```mermaid
flowchart TD
  A{"当前执行状态"}
  A -- "Runtime failed" --> B["报告失败，选择 error"]
  A -- "成功交接，需要审查" --> C["选择 completed"]
  A -- "其余情况" --> D["停止"]
```

Blocked：

- 没有可确认的本轮 Runtime 执行状态。
- 执行成功，但 Executor 尚未正式交接。
- 执行成功，但仍有未解决的正式 Human Input。
- 阶段提交未被 Runtime 接受。

Partial：

- 已收到的状态与 refs，保留在当前协调上下文中。

Exit：

- 适用的阶段结果已被接受，或 `execution_only` 执行结果已交付。

## Phase 4: Submit Task to Reviewer
---

Main Flow：

Knowledge：

- 本阶段要求 Runtime 的 `current_phase` 为 `review`。
- 审查目标是完成本轮审查并正式交付结果；输入引用按下表原样转交。
- 本阶段在推进成功后的新 response 中生成审查 prompt；沿用已经确认的 BDD 和目标版本，不重新选择。
- 首次审查使用 `AssignTask`（`tool-scout-assign-task`）；修正后继续审查使用 `SendMessage`（`tool-scout-send-message`），向原 Reviewer task 转交更正后的 refs。

| 输入来源 | 转交内容 |
| --- | --- |
| Executor formal handoff | `bdd_id`、`target_version`、`execute-pack-ref`（原样转交结构体）。 |
| 本轮 Runtime 执行通知 | 精确 `executor_history_ref`。 |

Flow：

```mermaid
flowchart TD
  A{"审查输入已收到？"}
  A -- "否" --> W["等待缺失输入，Blocked"]
  A -- "是" --> B{"已有本轮 Reviewer task？"}
  B -- "否" --> C["AssignTask"]
  B -- "是" --> D["沿用原 task，有更正引用则转交"]
  C --> E["进入 Phase 5 等待审查结果"]
  D --> E
```

Blocked：

- Runtime 尚未处于 `review`。
- 正式审查输入未收到。
- 派单或更正引用投递未成功。

Partial：

- `none`

Exit：

- 本轮 Reviewer task 已存在，或 `AssignTask` 返回 `assigned`。
- 本次需要转交的更正引用已投递，或没有更正。

## Phase 5: Coordinate Reviewer Outcome
---

Main Flow：

Knowledge：

- 只根据 Reviewer formal handoff 区分审查完成和退回修正。审查不通过、证据不足或执行无效也属于完整审查结果。
- 退回依据是 Reviewer 正式提出、明确无需重新执行的交付修正请求；原请求与 refs 保留给 Phase 2。
- 有待处理的正式 Human Input 时，选择停止；完整审查结论及 refs 原样交付用户。

Flow：

```mermaid
flowchart TD
  A{"Reviewer 当前正式状态"}
  A -- "审查完成" --> B["选择 completed"]
  A -- "正式请求交付修正" --> C["选择 error"]
  A -- "未完成或等待 Human Input" --> D["停止"]
```

Blocked：

- Reviewer 尚未形成正式交接。
- Reviewer 的交接未明确完成结论或修正请求。
- 仍有未解决的正式 Human Input。
- 阶段提交未被 Runtime 接受。

Partial：

- 已收到的审查状态与 refs，保留在当前协调上下文中。

Exit：

- 本轮审查的阶段结果已被 Runtime 接受。

## Workflow Exit Rules (Enforcement)

- XR-001：前一阶段未通过时，不进入依赖它的下一阶段。
- XR-002：派单或补充投递成功后结束当前 response，等待正式结果。
- XR-003：阶段结果被接受后立即结束当前 response；新 Runtime response 再处理后续阶段。
- XR-004：Phase 5 退回修正后，从 Phase 2 继续原任务；修正不产生新的执行。
- XR-005：本轮结束后的迟到交接仅补充交付，不重新启动流程。

## Prohibited Rules (Enforcement)

- PR-001：禁止 Coordinator 打开 artifact 正文检查格式、内容或证据；artifact 校验由 Runtime 负责，Coordinator 只消费正式状态和交接 refs。

## Checklist

- 任务对应唯一且已确认的 BDD。
- Executor 与 Reviewer 的派单和结果协调各在自己的阶段处理。
- 退回修正沿用原任务，审查不通过没有被当作重跑理由。
- 用户已收到正式结果、限制和 refs。

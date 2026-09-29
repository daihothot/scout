---
assetKind: scout.skill
name: tool-scout-submit-phase-outcome
description: Coordinator 判断当前 Workflow Phase 的结果并使用 SubmitPhaseOutcome 推进 Scheduler 时使用。
id: tool-scout-submit-phase-outcome
version: 1.0.0
type: tool
family: [tool, scout, dynamic, coordinator]
tags: [scout, dynamic-tool, workflow, phase]
devices: [any]
summary: 规定当前 Workflow Phase 结果的提交语义。
---

# Tool Scout Submit Phase Outcome

## Skill Type

- type: tool
- layout: compact
- note: 本技能拥有 SubmitPhaseOutcome 的调用契约，不拥有领域结果判断或 Task 生命周期。

## Tool Contract

- 仅 Coordinator 在自己的当前活动 Turn 中使用。
- `outcome` 只能是 `completed` 或 `error`。
- Coordinator 根据当前 Phase 的 Task 结果、超时、异常和人工信息判断 `outcome`。
- 推进前须结束已接受的 Worker 工作：排队、运行、等待人工输入、尚未退出的 Worker Step，以及已完成 Task 的待处理消息都会阻止推进。被拒绝时，根据 Runtime 返回的原因完成收尾后重试。
- 工具只把结果交给 Scheduler；Scheduler 根据 Workflow Profile 中当前 Phase 的 edge 推进游标。
- 每个 Turn 最多成功推进一次；收到接受结果后结束当前 response，不在同一 Turn 提交下一 Phase 的结果。被拒绝的调用不占用成功推进次数。

## Result Rules

- `status: accepted` 表示 Scheduler 已消费当前 Phase 的结果。
- Runtime 在同一 Turn 重复投递同一个已成功调用（相同调用标识和 `outcome`）时返回原回执，不再次推进；这不允许 Agent 另发一次调用继续推进。
- `cycleCompleted: false` 表示游标已进入下一个 Phase，Runtime 将启动新的 Coordinator Step。
- `cycleCompleted: true` 表示 Graph 已终止、Workflow 进入 `settling`，不表示 Workflow 已完成。Runtime 统一释放已结束的 Worker 任务绑定，完成收尾后进入无活动 Workflow 状态，不自动开启下一次执行。只有之后接受 `StartWorkflow` 并成功开启，游标才重置到第一个 Worker Phase。

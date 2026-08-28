---
assetKind: scout.skill
name: tool-scout-submit-phase-outcome
description: Coordinator 判断当前 Workflow Phase 的结果并使用 SubmitPhaseOutcome 推进 Scheduler 时使用。
id: tool-scout-submit-phase-outcome
version: 1.0.0
phase: [Synthesis]
family: [tool, scout, dynamic]
tags: [scout, dynamic-tool, workflow, phase]
devices: [any]
summary: 规定当前 Workflow Phase 结果的提交语义。
---

# Tool Scout Submit Phase Outcome

## Skill Type

- type: tool
- structure_level: compact
- note: 本技能拥有 SubmitPhaseOutcome 的调用契约，不拥有领域结果判断或 Task 生命周期。

## Tool Contract

- 仅 Coordinator 使用。
- `outcome` 只能是 `completed` 或 `error`。
- Coordinator 根据当前 Phase 的 Task 结果、超时、异常和人工信息判断 `outcome`。
- 工具不要求 Task 已完成、已归档，也不要求 Human Input 已解决。
- 工具只把结果交给 Scheduler；Scheduler 根据 Workflow Profile 中当前 Phase 的 edge 推进游标。

## Result Rules

- `status: accepted` 表示 Scheduler 已消费当前 Phase 的结果。
- `cycleCompleted: false` 表示游标已进入下一个 Phase，Runtime 将启动新的 Coordinator Step。
- `cycleCompleted: true` 表示本轮流程已结束，游标已重置到第一个 Worker Phase，Run 进入 idle。

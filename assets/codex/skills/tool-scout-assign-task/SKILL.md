---
assetKind: scout.skill
name: tool-scout-assign-task
description: Coordinator 使用 AssignTask 向当前 Run 中已有 Worker 分配新任务时使用。
id: tool-scout-assign-task
version: 1.0.0
phase: [coordinate]
family: [tool, scout, dynamic]
tags: [scout, dynamic-tool, task, assignment]
devices: [any]
summary: 规定 AssignTask 的目标选择、输入完整性和返回状态语义。
---

# Tool Scout Assign Task

## Skill Type

- type: tool
- structure_level: compact
- note: 本技能拥有 AssignTask 的调用契约，不拥有领域路由决策或 Worker 工作内容。

## Tool Contract

- 仅 Coordinator 使用。
- `subagent_type` 选择当前 Run 中已有的 `researcher`、`verifier` 或 `validator`；仅在需要精确指定时填写匹配角色的 `agent_id`。
- `description` 是简短任务标签；`prompt` 是完整中文任务指令，必须包含目标、已确认输入、正式 refs、边界、期望输出和 handoff 要求。
- 工具只分配 Scout Worker task，不创建 Codex native subagent。

## Result Rules

- `status: assigned` 表示任务已创建并返回稳定 `taskId`，不表示 Worker 已开始或完成。
- `status: not_assigned` 表示目标 Worker 仍绑定未归档任务；保留 `activeTaskId`，先处理原任务，不得重复分配。
- 工具错误或未返回 `assigned` 时，不得声称任务已派发。


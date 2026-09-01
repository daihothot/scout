---
assetKind: scout.skill
name: tool-scout-assign-task
description: Coordinator 使用 AssignTask 向当前 Workflow Phase 中的空闲 Worker 分配新任务时使用。
id: tool-scout-assign-task
version: 1.0.0
type: tool
family: [tool, scout, dynamic, coordinator]
tags: [scout, dynamic-tool, task, assignment]
devices: [any]
summary: 规定 AssignTask 的 Phase 路由、输入完整性和返回状态语义。
---

# Tool Scout Assign Task

## Skill Type

- type: tool
- layout: compact
- note: 本技能拥有 AssignTask 的调用契约，不拥有领域路由决策或 Worker 工作内容。

## Tool Contract

- 仅 Coordinator 使用。
- `description` 是简短任务标签；`prompt` 是完整中文任务指令，必须包含目标、已确认输入、正式 refs、边界、期望输出和 handoff 要求。
- Coordinator 不传 Phase、role 或 Agent；Runtime 使用 `GraphState.currentPhase`，由当前 Phase 按声明顺序选择第一个空闲 Worker。
- 工具只分配 Scout Worker task，不创建 Codex native subagent。

## Result Rules

- `status: assigned` 表示任务已创建并返回稳定 `taskId`，不表示 Worker 已开始或完成。
- `status: not_assigned` 表示当前 Phase 没有空闲 Worker；根据 `reason` 处理已有 Task 或等待 Worker 可用。
- 工具错误或未返回 `assigned` 时，不得声称任务已派发。

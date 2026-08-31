---
assetKind: scout.skill
name: tool-scout-archive-task
description: Coordinator 确认 Worker task 不再需要继续后使用 ArchiveTask 归档该 task。
id: tool-scout-archive-task
version: 1.0.0
type: tool
family: [tool, scout, dynamic]
tags: [scout, dynamic-tool, task, archive]
devices: [any]
summary: 规定 ArchiveTask 的调用时机和归档边界。
---

# Tool Scout Archive Task

## Skill Type

- type: tool
- layout: compact
- note: 本技能拥有 task runner 的归档操作契约，不判断领域结果是否正确或全局目标是否完成。

## Tool Contract

- 仅 Coordinator 使用。
- `task_id` 必须准确指向目标 Worker 当前绑定的 task。
- 只有确认该 Worker 不再需要对当前 task 修正、补充或等待人工回复后才归档。
- Worker 的 `done` 只表示已提交一轮 handoff；需要继续时使用 SendMessage 投递原 task，不要归档后重建任务。

## Result Rules

- `status: archived` 表示当前 TaskRunner 已释放；Worker 的 Agent thread 和 StepRunner 保留，可在后续接收新 task。
- 归档不等于 handoff accepted、领域 gate 通过或全局目标完成。
- task 未达到可归档状态、归属不匹配或工具失败时先处理该状态，不得把失败解释为已释放 Worker。

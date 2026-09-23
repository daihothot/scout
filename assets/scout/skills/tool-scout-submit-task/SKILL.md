---
assetKind: scout.skill
name: tool-scout-submit-task
description: Worker 使用 SubmitTask 将当前任务的正式 handoff 提交给 Coordinator 时使用。
id: tool-scout-submit-task
version: 1.0.0
type: tool
family: [tool, scout, dynamic, worker]
tags: [scout, dynamic-tool, task, handoff]
devices: [any]
summary: 规定 SubmitTask 的正式输出、当前 turn 所有权和 disposition 语义。
---

# Tool Scout Submit Task

## Skill Type

- type: tool
- layout: compact
- note: 本技能拥有 Worker 正式 task handoff 的提交契约，不定义领域 artifact 或 handoff 字段。

## Tool Contract

- 仅拥有当前 active task 和活动 turn 的 Worker 使用。
- 调用前必须完成适用角色与领域 Skill 要求的工作和正式 artifact；`outcome` 使用对应 handoff contract 的完整中文 Markdown。
- `outcome` 中的 artifact 引用必须是当前 task 可交付的正式引用；普通进度、工具活动或未落盘摘要不能冒充正式结果。
- 存在未解决人工请求时禁止提交。

## Result Rules

- `status: accepted` 表示当前 handoff 已被 Runtime 接受并进入 `done`，不表示 Coordinator 已归档，也不表示领域目标完成。
- 此调用是当前 step 的 `handoff_submitted` disposition，不能在同一 step 再调用 RequestHumanInput。
- 调用失败时修正真实问题后重试；不得用 final response 伪装提交成功。

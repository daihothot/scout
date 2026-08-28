---
assetKind: scout.skill
name: tool-scout-respond-human-input
description: Coordinator 将用户对正式人工请求的明确回复送回原 Worker task 时使用 RespondHumanInput。
id: tool-scout-respond-human-input
version: 1.0.0
phase: [Synthesis]
family: [tool, scout, dynamic]
tags: [scout, dynamic-tool, human-input, task]
devices: [any]
summary: 规定人工回复与原请求、原任务的精确匹配和投递语义。
---

# Tool Scout Respond Human Input

## Skill Type

- type: tool
- structure_level: compact
- note: 本技能拥有人工回复投递契约，不拥有 Worker 的领域判断。

## Tool Contract

- 仅 Coordinator 使用。
- `task_id` 必须是仍为 `running` 且存在唯一未解决人工请求的原 Worker task。
- `response` 只包含用户明确确认的中文内容和必要匹配上下文；不得由 Coordinator 补造、扩大或替用户解释领域事实。
- 用户回复不匹配原问题时先继续向用户澄清，不调用本工具。

## Result Rules

- `status: queued` 表示回复已排队给原 Worker，并返回原 `requestId`；不表示 Worker 已完成后续工作。
- SendMessage 不能替代本工具关闭人工请求。
- 没有未解决请求、任务状态不匹配或目标错误时停止，不创建新 task 规避失败。

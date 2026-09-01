---
assetKind: scout.skill
name: tool-scout-request-human-input
description: Worker 当前任务必须等待人工确认才能继续时使用 RequestHumanInput。
id: tool-scout-request-human-input
version: 1.0.0
type: tool
family: [tool, scout, dynamic, worker]
tags: [scout, dynamic-tool, human-input, task]
devices: [any]
summary: 规定 Worker 人工输入请求的触发条件、正文和等待语义。
---

# Tool Scout Request Human Input

## Skill Type

- type: tool
- layout: compact
- note: 本技能拥有 Worker 人工输入请求的生命周期契约，不判断领域事实是否必须人工确认。

## Tool Contract

- 仅拥有 `running` task 和当前活动 turn 的 Worker 使用。
- 只有适用领域 Skill 判定缺失或冲突事实必须由人工确认、且没有该确认无法继续时才调用。
- `request` 必须用中文写明 task、已确认内容、缺失或冲突事实、影响、一个最小问题和期望回答形态。
- 同一 task 同时只能有一个未解决请求；等待期间保留当前 task，不提交 handoff，也不继续依赖该回答的工作。

## Result Rules

- `status: queued` 表示请求已送往 Coordinator；保存返回的 `requestId`。
- 此调用是当前 step 的 `waiting_for_human` disposition，不能在同一 step 再调用 SubmitTask。
- 普通消息、final response 或 blocked handoff 不能替代本工具。

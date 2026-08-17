---
assetKind: scout.skill
name: tool-scout-send-message
description: Scout Agent 使用 SendMessage 向已有 Agent 或其当前任务发送普通消息时使用。
id: tool-scout-send-message
version: 1.0.0
phase: [coordinate, research, verify, validate]
family: [tool, scout, dynamic]
tags: [scout, dynamic-tool, message]
devices: [any]
summary: 规定 SendMessage 的目标绑定与普通消息语义。
---

# Tool Scout Send Message

## Skill Type

- type: tool
- structure_level: compact
- note: 本技能拥有普通 Agent 消息投递契约，不拥有 task disposition 或人工确认生命周期。

## Tool Contract

- `to` 使用准确 task id 时，消息绑定该 Worker task；使用 agent id 时，消息发送给该 Agent 当前可接收的 runner。
- `message` 使用中文，包含接收方能够直接执行所需的上下文，不依赖发送方私有对话记忆。
- 对已有 task 的补充、修正或追问优先使用 task id，避免把内容投递到错误生命周期。

## Result Rules

- `status: queued` 只表示消息已排队，不表示接收方已处理、接受或完成。
- SendMessage 不能替代 AssignTask、RequestHumanInput、RespondHumanInput、SubmitTask 或 ArchiveTask。
- 目标不存在、没有可接收 runner 或工具失败时，不得把消息描述为已送达。


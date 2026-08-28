---
assetKind: scout.skill
name: tool-scout-send-message
description: Scout Agent 使用 SendMessage 向已有 Agent 或其当前任务发送消息时使用。
id: tool-scout-send-message
version: 1.0.0
phase: [Synthesis, research, verify, research-reviewer, verify-reviewer]
family: [tool, scout, dynamic]
tags: [scout, dynamic-tool, message]
devices: [any]
summary: 规定 SendMessage 的目标绑定与 steer/queued 投递语义。
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
- 默认投递模式是 `steer`：目标 Agent 有 active turn 时，Runtime 使用 `turn/steer` 将消息追加到该 turn；没有 active turn 时才启动一个新 turn。
- 只有明确要求等待当前 turn 结束后再处理时，才传 `delivery_mode: "queued"`。

## Result Rules

- `status: queued` 只表示消息已被 Runtime 接受，不表示接收方已处理、接受或完成；返回的投递模式可能是 steer 或 queued。
- SendMessage 不能替代 AssignTask、RequestHumanInput、RespondHumanInput、SubmitTask、ArchiveTask 或 SubmitPhaseOutcome。
- 目标不存在、没有可接收 runner 或工具失败时，不得把消息描述为已送达。

---
assetKind: scout.skill
name: tool-scout-start-workflow
description: Coordinator 在没有活动 Workflow 时，根据用户明确的新执行需求开启 Workflow 时使用。
id: tool-scout-start-workflow
version: 1.0.0
type: tool
family: [tool, scout, dynamic, coordinator]
tags: [scout, dynamic-tool, workflow]
devices: [any]
summary: 定义显式开启 Workflow 的意图提交与 Turn 边界。
---

# Tool Scout Start Workflow

## Tool Contract

- 仅 Coordinator 在自己的活动 Turn 中调用，且当前 `workflow_status` 必须为 `empty`。
- 只在用户明确要求新的执行时调用。历史回顾、状态查询、澄清或一般交流不构成开启条件。
- 先按当前 Domain Skill 确认开启所需输入，再生成 `name`。工具只接收 `name`，它是 Workflow 的展示名称，不是路径或执行 prompt。
- `status: accepted` 只表示开启请求已接受，不表示 Workflow 已创建或工作已执行。
- 接受后立即结束当前 response，不派发任务、不写 artifact。Runtime 在本次 Turn 和 Step 结束后提交 Workflow，并在同一 Thread 开始下一次 response。
- 下一次 response 使用最新 `workflow_context` 和 `workflow_phase`，按 Domain Skill 生成任务 prompt 并派发工作；不在开启请求中预先提交 prompt。路径与引用遵循 `AGENTS.md` 的 Workflow Context。

## Failure Rules

- 活动 Workflow 尚未结束、调用者不是 Coordinator、Turn 不匹配或本 Turn 已接受另一请求时，调用失败；不尝试绕过约束。
- 开启失败时如实报告 Runtime 错误，不宣称已派发或已执行。不得因查看历史而自动重试开启。

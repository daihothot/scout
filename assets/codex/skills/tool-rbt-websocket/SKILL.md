---
assetKind: scout.skill
name: tool-rbt-websocket
description: 为 RBT Domain 建立、复用和断开 Jarvis Behavioral WebSocket session 时使用。
id: tool-rbt-websocket
version: 0.1.0
type: tool
family: [tool, rbt, websocket]
tags: [rbt, websocket, session, dynamic-tool]
devices: [any]
summary: 约束 JarvisWebsockt 的 session 连接事实和 endpoint 冲突边界。
---

# RBT WebSocket Tool

`JarvisWebsockt` 是 RBT Domain 的 dynamic tool。当前它作为 Behavior Tool 的内部依赖使用，尚未注册为 Agent 入口；后续注册时仍使用本 contract。它只管理 Jarvis daemon-backed WebSocket session。

## 职责

- 检查目标 `session-id` 的当前连接状态。
- 使用调用方提供的 `endpoint` 建立连接，或复用已连接到同一 endpoint 的 session。
- 拒绝已经指向其它 endpoint 的 session，不使用强制覆盖。
- 断开指定 session，并返回连接操作的实际事实。

schema 配置、Behavioral command、结果解读、平台状态和 campaign 记录属于调用它的 RBT Tool 或 Domain，不在本技能中处理。

## Connection Contract

调用方必须提供实际的 `session-id` 和 `endpoint`。endpoint 不从默认值猜测；session 已连接到其它 endpoint 时返回 `websocket_endpoint_conflict`。

连接输入：

```json
{
  "operation": "connect",
  "session_id": "<session-id>",
  "endpoint": "<endpoint>"
}
```

断开只需要将 `operation` 改为 `disconnect` 并保留 `session_id`。

连接成功必须同时确认：

| 事实 | 要求 |
| --- | --- |
| session | status 返回的 session 与请求一致 |
| state | status 表示 `connected` |
| endpoint | status 返回的 URL 与请求 endpoint 一致 |

连接结果区分 `connected`（本次建立）和 `reused`（已连接且复用）。状态检查、连接和最终确认任一步失败，都不能返回 connected。

## Lifecycle

一次连接流程按以下顺序进行：

1. 检查 session 状态并识别 endpoint 冲突。
2. 未连接时建立 session。
3. 再次检查并确认 session、状态和 endpoint。

断开只改变 WebSocket session，不代表 Scenario 或 campaign 已停止；这些生命周期由 RBT Behavior Tool 负责。

## Failure Boundary

- `websocket_input_missing`：缺少 session 或 endpoint。
- `websocket_endpoint_conflict`：现有连接指向不同 endpoint。
- `websocket_connect_failed`：连接命令失败或超时。
- `websocket_status_unconfirmed`：连接后无法确认最终连接事实。

不得把 status、connect 或 disconnect 的宿主输出改写成 Behavioral command 结果，也不得在本技能中读取或配置 schema。

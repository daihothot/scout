---
assetKind: scout.skill
name: tool-jarvis-websocket
description: 通过 Jarvis CLI 建立或复用一个命名 WebSocket session，并返回连接事实时使用。
id: tool-jarvis-websocket
version: 0.2.0
type: tool
family: [tool, jarvis, websocket]
tags: [jarvis, websocket, session, connection]
devices: [any]
dependencies:
  shellTools:
    required: [jarvis]
summary: 规范 Jarvis WebSocket session 的状态检查、连接建立和连接结果边界。
---

# Jarvis WebSocket Tool

当前 task 已经明确要通过 Jarvis CLI 建立一个 WebSocket session 时，使用本技能完成连接。

使用本技能时，你只负责检查目标 session、建立或复用连接，并返回实际连接事实。连接成功后，本技能结束；schema 配置、operation 调用、返回处理和后续 session 操作由调用本技能的 Tool Skill 负责。

## Skill Type

- type: tool
- layout: workflow
- note: 使用一种固定的 Jarvis CLI 机制建立 daemon-backed WebSocket session。

## Core Use

使用本技能处理：

- 检查一个命名 WebSocket session 的当前状态。
- 建立 session，或复用已经连接到同一 endpoint 的 session。
- 返回 session identity、endpoint 和连接状态。

职责边界：本技能只拥有 session 检查和连接建立；schema、operation、返回处理、平台启动和连接后的收尾由对应 Tool / Domain Skill 负责。

## Session Model

- `daemon-backed session` 是 Jarvis daemon 保存的命名 WebSocket 连接。
- `endpoint` 是调用方已经确定的目标 WebSocket URL。
- `connected session` 表示 Jarvis status 能同时确认 session 已连接并指向输入 endpoint。

以下名称表示调用时必须从当前上下文取得的实际值：

- `endpoint` 表示目标 WebSocket Runtime 的实际 URL。
- `session-id` 表示当前调用链使用的 Jarvis session identity。
- `idle-ms` 表示 Jarvis status 返回的实际 session idle 毫秒数。

本技能只使用当前 Jarvis CLI 实现：

```text
jarvis ws
```

目标 Runtime 运行在 Unity、Android 或 iOS 不改变连接机制。平台专用的 endpoint 准备属于其它 Tool contract。

## Inputs

### I-001: Target Session
---

描述：

- 实际 `endpoint` 和本次调用链使用的 `session-id`。

Required：`endpoint`、`session-id`。

Optional：已有 session 状态和 `idle-ms`，用于决定复用或报告现状。

Missing：缺少任一 required 值时阻塞连接，不猜测默认 endpoint 或 session。

Confirmation：确认 status 显示的 session identity、连接状态和 endpoint 与输入一致。

注意事项：

- 不得根据 Jarvis 默认地址或示例地址猜测当前目标。
- 现有 `session-id` 指向其它 endpoint 时，不得使用 `--force` 静默替换；停止并向调用方返回冲突事实。

## Workflow Overview

Knowledge：本技能只需要 endpoint、session identity 和 Jarvis status 的连接事实；不读取 schema 或 operation 语义。

Flow：

- Phase 1：确认 Jarvis 可用，并检查 `session-id` 的当前连接状态。
- Phase 2：建立或复用指向输入 endpoint 的 session，并返回连接事实。

## Result Contract

本技能返回以下连接事实：

- 实际 `session-id` 和 endpoint。
- Jarvis CLI 退出状态。
- session 是新建连接还是复用现有连接。
- 最终 status 返回的连接状态和 `idle-ms`。
- 失败发生在 Jarvis CLI、session 状态检查还是连接建立。

本技能不生成持久 artifact。连接成功后，直接使用本技能的 Tool Skill 接管该 session。

## Phase 1: Inspect Session
---

Knowledge：只确认 Jarvis CLI 和目标 session 的当前连接状态。

确认当前 Jarvis 可执行，并检查目标 session：

```bash
jarvis version
jarvis ws status --session "<session-id>"
```

`status` 在 session 已连接时退出状态为零；未连接时退出状态为一。已连接时必须核对状态中的 URL。

Exit：

- `jarvis version` 成功，且已取得目标 session 的真实状态。

Blocked：

- `jarvis` 不可用，或无法取得 session 状态且不能确认该 session 是否可安全使用。

Partial：

- `none`。

## Phase 2: Establish Session
---

Knowledge：只使用输入 endpoint 建立或复用连接，不改变已连接到其它 endpoint 的 session。

未连接时，使用输入 endpoint 建立连接：

```bash
jarvis ws connect --session "<session-id>" --url "<endpoint>"
```

session 已连接到当前 endpoint 时直接复用。session 已连接到其它 endpoint 时停止，不使用 `--force` 改写现有连接。

连接后再次检查状态：

```bash
jarvis ws status --session "<session-id>"
```

成功状态行必须同时显示当前 session、`connected` 和输入 endpoint，例如：

```text
WS session <session-id>: connected url=<endpoint> idle=<idle-ms>
```

Exit：

- `session-id` 已连接到输入 endpoint；连接事实已经返回给调用本技能的 Tool Skill。

Blocked：

- 连接失败、session 指向其它 endpoint，或最终状态不能同时确认 connection 和 endpoint。

Partial：

- 已发现 session 指向其它 endpoint 时，返回现状并阻塞连接，不改变现有 session。

## Workflow Exit Rules (Enforcement)

- XR-001：只有 status 能确认 `session-id` 已连接到输入 endpoint，才能返回 connected session。
- XR-002：返回 connected session 后，本技能立即结束。

## Failure Rules (Enforcement)

- FR-001：Jarvis CLI、session 状态检查和连接失败必须按实际层次报告，不能改写为 connected。
- FR-002：`connect` 命令退出成功但后续 status 不能确认 endpoint 时，不能形成连接成功事实。

## Blocking Rules (Enforcement)

- BR-001：缺少实际 `endpoint` 或 `session-id` 时阻塞连接。
- BR-002：现有 session endpoint 与输入 endpoint 不一致时阻塞连接。

## Retry Rules (Enforcement)

- RR-001：`version` 和 `status` 只读检查可以在一次明确的瞬时 CLI 失败后以相同输入重试一次。
- RR-002：连接失败后不得通过改变 endpoint 或 session identity 把失败改写成成功。

## Prohibited Rules (Enforcement)

- PR-001：禁止使用 `--force` 静默替换指向其它 endpoint 的 session。
- PR-002：禁止在本技能中查找或配置 schema。
- PR-003：禁止在本技能中调用 operation、处理返回值或执行连接后的 session 收尾。

## Checklist

- `endpoint` 和 `session-id` 来自当前调用方的正式输入。
- `session-id` 已连接到输入 endpoint，或已按真实状态报告阻塞。
- 没有使用 `--force` 替换现有 session。
- connected session 已返回给调用本技能的 Tool Skill。
- 没有查找或配置 schema，也没有调用 operation 或处理返回值。

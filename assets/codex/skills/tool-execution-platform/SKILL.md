---
assetKind: scout.skill
name: tool-execution-platform
description: 当前 <role> 需要通过 ExecutionPlatform dynamic tool 启动或关闭当前执行平台会话时使用。
id: tool-execution-platform
version: 0.2.0
type: tool
family: [tool, scout, dynamic, execution]
tags: [execution, platform, dynamic-tool, lifecycle]
devices: [any]
summary: 规范 ExecutionPlatform dynamic tool 的平台会话启动与关闭操作。
---

# Execution Platform Tool

当当前 Phase 明确提供 `ExecutionPlatform` dynamic tool，并需要启动或关闭当前执行平台会话时使用本技能。

本技能只拥有 Agent 可见的平台操作 contract。具体 transport、命令协议、进程、设备连接和底层状态轮询由 Scout Runtime 管理。

## Skill Type

- type: tool
- layout: compact
- note: 本技能不定义具体平台或 transport 的实现方法。

## Operation Contract

| operation | 作用 | 状态影响 |
| --- | --- | --- |
| `launch` | 建立或复用当前执行会话，并等待 Platform 达到可执行状态。 | 创建或复用当前会话。 |
| `shutdown` | 关闭当前执行会话对应的 Platform。 | 成功后结束当前会话。 |

调用只提供 `operation`，不得提交 platform type、version、transport、设备 selector 或底层命令。Platform 识别、Adapter 选择与当前会话由 Scout Runtime 管理。

## Result Contract

成功结果包含：

```json
{
  "operation": "launch | shutdown",
  "status": "completed",
  "identity": {
    "type": "<platform-type>",
    "version": "<platform-version>"
  }
}
```

失败结果包含：

```json
{
  "operation": "<operation>",
  "status": "failed",
  "code": "<failure-code>",
  "message": "<failure-message>"
}
```

`completed` 表示对应生命周期操作已经达到 Runtime 定义的目标状态。transport 命令成功、连接建立或请求被接受不能单独替代该结果。

## Boundaries

- 只使用当前 Phase 实际投放的 `ExecutionPlatform`。
- `launch` 和 `shutdown` 不接收或转发底层 transport 参数。
- 构建、安装、日志导出、证据采集、业务命令和结果判定不属于本 Tool。
- 失败结果不能解释为平台已启动、已停止或业务执行完成。
- 不得绕过本 Tool 调用其内部 transport。

## Retry

- `launch` 或 `shutdown` 返回失败后，不直接重复；保留 Runtime 返回的失败并交由当前 Domain 流程处理。

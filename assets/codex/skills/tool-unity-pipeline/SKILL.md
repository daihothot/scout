---
assetKind: scout.skill
name: tool-unity-pipeline
description: 当前 <role> 通过 UnityPipeline dynamic tool 查询 Unity CLI、已连接 Unity Editor 或控制 Editor Play Mode 时使用。
id: tool-unity-pipeline
version: 0.1.0
type: tool
family: [tool, unity, pipeline]
tags: [unity, pipeline, dynamic-tool, editor, play-mode]
devices: [any]
summary: 规范 UnityPipeline dynamic tool 的语义输入、结果与 Editor Play Mode 生命周期边界。
---

# Unity Pipeline Tool

当当前平台是 Unity Editor，需要查询已打开的 Editor 运行实例或控制其 Play Mode 时，使用 `UnityPipeline` dynamic tool。

本技能只拥有 `<role>` 可见的 `UnityPipeline` 调用 contract。宿主 CLI 路径、进程环境、原始 stdout/stderr 和 shell 执行由 Scout Runtime 管理。

## Skill Type

- type: tool
- layout: compact
- note: 本技能定义 Unity Editor 平台 dynamic tool 的输入、输出与状态影响。

## Core Use

使用本技能处理：

- 读取 Unity Pipeline CLI 版本。
- 查询或列出当前宿主上的 Unity Editor 运行实例。
- 对唯一确认的 Editor 运行实例启动、查询或停止 Play Mode。

## Operation Contract

调用 `UnityPipeline` 时提供一个 operation：

| operation | 作用 | 状态影响 |
| --- | --- | --- |
| `version` | 返回当前 Unity Pipeline CLI 版本。 | 无。 |
| `status` | 查询当前唯一目标或发现状态。 | 无。 |
| `list` | 列出唯一目标当前注册的 Pipeline commands。 | 无。 |
| `editor_play` | 让唯一目标进入 Play Mode。 | 修改当前 Editor 运行状态。 |
| `editor_status` | 查询唯一目标的 Play Mode 状态。 | 无。 |
| `editor_stop` | 让唯一目标退出 Play Mode。 | 修改当前 Editor 运行状态。 |

`timeout_seconds` 可选，必须是 `1..120` 的整数，默认 `30`；它限制本次宿主调用，并作为 `editor_*` command timeout。

## Inputs

### I-001: Unity Pipeline Operation
---

Required：

- `operation`：上表中的一个实际值。

Optional：

- `timeout_seconds`：`editor_*` 操作的超时时间。

Missing：

- `operation` 缺失、未知或字段类型错误时，调用失败；不得改用 `<role>` shell 直接执行 Unity CLI。

Confirmation：

- dynamic tool 返回结构化结果，且 `status: completed`，当前 operation 的必需字段完整。

## Result Envelope

工具将 Unity CLI 输出解析后返回；`result` 不再是需要二次解析的 JSON 字符串：

```json
{
  "operation": "<operation>",
  "status": "completed | failed | timed_out",
  "result": {},
  "errors": [],
  "warnings": [],
  "error": "<仅失败时可能存在>"
}
```

| 字段 | 含义 |
| --- | --- |
| `operation` | 本次实际执行的 operation。 |
| `status` | `completed` 表示宿主命令成功且返回结构有效；`failed` 表示执行、解析或 CLI 结果失败；`timed_out` 表示宿主执行超时。 |
| `result` | 当前 operation 的结构化结果；失败发生在结果形成前时不存在。 |
| `errors` | Unity CLI 返回的结构化错误；空时省略。 |
| `warnings` | Unity CLI 返回的结构化警告；空时省略。 |
| `error` | Scout Runtime 对当前失败边界的直接说明；成功时不存在。 |

原始宿主命令、exit code、stdout 和 stderr 只进入 Scout Runtime telemetry，不要求 `<role>` 解析或保存。

## Operation Results

### `version`

```json
{
  "operation": "version",
  "status": "completed",
  "result": {
    "version": "<unity-cli-version>"
  }
}
```

- `result.version` 是本次宿主 Unity CLI 返回的非空版本字符串，不是 Unity Editor 版本。
- Unity Editor 版本必须从 `status.result.instances[].version` 读取。

### `status`

```json
{
  "operation": "status",
  "status": "completed",
  "result": {
    "count": 1,
    "instances": [
      {
        "version": "<unity-editor-version>",
        "state": "ready"
      }
    ]
  }
}
```

- `count` 是当前发现的 Editor 数量，必须与 `instances` 一起读取。
- `count: 0` 表示没有已连接 Editor；`count > 1` 表示无 selector 调用无法唯一选择目标。
- `instances[].version` 是 Unity Editor 版本；`instances[].state` 是实例当前可用状态。
- 只有 `count: 1` 且唯一实例状态可用时，才能直接执行 Editor operation。

### `list`

```json
{
  "operation": "list",
  "status": "completed",
  "result": {
    "count": 1,
    "commands": ["<command-name>"]
  }
}
```

- `result.commands` 只列出当前实例实际注册的 command 名称；CLI 的描述、分组和参数 schema 不返回给 `<role>`。
- `count: 0` 是有效结果，但表示当前实例没有可调用 command。

### `editor_play`、`editor_status`、`editor_stop`

```json
{
  "operation": "editor_status",
  "status": "completed",
  "result": {
    "status": "ready",
    "playMode": "stopped",
    "compiling": false,
    "domainReloadInProgress": false,
    "unityVersion": "<unity-editor-version>"
  }
}
```

- `result.playMode` 是当前 Play Mode 状态。
- `result.status` 是 Editor 的可用状态；`result.unityVersion` 是 Unity Editor 版本。
- `editor_play` 或 `editor_stop` 成功只说明动作 command 完成；随后必须调用 `editor_status`，分别确认 `playMode: playing` 或 `playMode: stopped`。
- `result.compiling: true` 或 `result.domainReloadInProgress: true` 表示 Editor 尚未稳定。

### Failure

```json
{
  "operation": "status",
  "status": "failed",
  "error": "<failure-boundary>"
}
```

- `result` 缺失表示命令失败发生在有效 operation result 形成之前。
- `status: failed` 即使带有部分 `result`、`errors` 或 `warnings`，也不能作为平台已就绪事实。
- `status: timed_out` 后，具有副作用的 operation 是否到达目标未知；必须先查询实际状态。

## Failure Rules (Enforcement)

- FR-001：`failed`、`timed_out`、缺失必需结果字段或 operation/result 不配对，均不得作为平台已就绪事实。

## Retry Rules (Enforcement)

- RR-001：只读 operation 可以在输入和目标不变时重试一次；`editor_play`、`editor_stop` 的结果未知时，必须先用 `editor_status` 确认状态，不能直接重复副作用操作。

## Prohibited Rules (Enforcement)

- PR-001：禁止绕过本 dynamic tool 直接调用它内部使用的 Unity shell wrapper。
- PR-002：禁止在未唯一确认 Editor 运行实例时执行 `editor_play` 或 `editor_stop`。

## Checklist

- operation 与当前平台动作一致。
- 副作用操作前已经唯一确认目标。
- 使用结构化 `status` 和当前 operation 的 `result` 判断工具结果。

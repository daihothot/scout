---
assetKind: scout.skill
name: tool-rbt-behavior
description: 通过 JarvisBehavior dynamic tool 执行一个 RBT execute-file，或发送一条只读 Behavioral 查询命令。
id: tool-rbt-behavior
version: 0.3.0
type: tool
family: [tool, rbt, behavior]
tags: [rbt, behavior, dynamic-tool, campaign, evidence]
devices: [any]
summary: 规范 JarvisBehavior 的执行文件入口、只读查询入口和 Agent 可见结果。
---

# RBT Behavior Tool

当当前 `<role>` 需要执行一个已经形成的 RBT 执行文件，或查询当前 Behavioral Runtime 能力和证据时，使用 `JarvisBehavior`。

本技能只定义这个 Dynamic Tool 的输入、Agent 可见输出、失败和退出边界。

## Input Forms

两种输入互斥，只能选择一种。

### Execute File

```json
{
  "execute_file": "<bdd-id>/<version>/execute-file.json"
}
```

- `execute_file` 可以是当前 Agent artifact root 下的相对路径或绝对路径。
- 路径必须落在当前 Agent artifact root 内，且结构必须是 `<bdd-id>/<version>/execute-file.json`。
- 文件格式、命令顺序和内容由生成该 artifact 的 Skill 负责；本工具会在发送 mutation 前校验文件结构、允许命令、必需 identity 和全局顺序。
- 一次调用执行文件中的完整序列。调用方不再逐条发送 campaign mutation。

### Read-only Query

```json
{
  "command": "behavior.node.variants",
  "payload": {
    "id": "<node-id>"
  }
}
```

- `command` 和 `payload` 必须同时存在。
- `payload` 直接使用当前 Behavioral command schema，不增加 request envelope。
- 当前 Phase 允许哪些查询由 RBT Domain 决定；本技能不按角色分配权限。

## Agent Input Boundary

调用方不提供也不会在 Agent 结果中看到：

- request `version`；
- request/result `correlationId`；
- WebSocket endpoint 和 session ID；
- command timeout；
- schema path；
- Jarvis CLI 与宿主 shell 输入输出。

当前平台前提是存在唯一、人工已准备并可连接的 Unity Editor。调用方不需要为 `JarvisBehavior` 预先调用 `UnityPipeline`。

## Read-only Commands

| command | payload 的关键输入 | 成功结果主要读取 |
| --- | --- | --- |
| `behavior.registry.nodes` | `{}` | `nodes` descriptors。 |
| `behavior.node.variants` | `id` | 该 node 的 `variants` 和 `paramsSchema`。 |
| `behavior.evidence.sources` | `{}` | `sources`、kind 与 query capabilities。 |
| `behavior.trigger.commands` | `{}` | trigger identities、`paramsSchema` 与 `resultSchema`。 |
| `behavior.campaign.query` | 当前 schema 支持的 campaign/Journal filters | `campaigns`；请求包含 evidence 时读取 historical `evidence`。 |
| `behavior.evidence.query` | `sourceId`；可选 kind、match、fields、limit、sinceSequence 等 | 当前 live source 返回的 `evidence`。 |

空数组是有效成功结果，表示当前过滤条件下没有数据；不能自动解释为命令失败。

### Query Constraints

- identity、variant、operator、field 和参数只能使用当前查询实际返回的 descriptor。
- `behavior.evidence.query` 的 `sinceSequence` 针对 live record 自身的 sequence，不是 Campaign Journal cursor；当前 source 若返回 `sequence: 0`，传 `sinceSequence: 0` 会将其过滤掉。
- 同时使用 `match` 和 `fields` 时，`fields` 必须包含全部 match 字段；Runtime 会在投影结果上再次执行 match，缺字段可能得到意外空结果。
- `limit: 0` 会成功返回空结果。
- `behavior.campaign.query` 的 campaign `evidenceCount` 是完整 Journal 数量，不一定等于过滤后的 `evidence.length`。

## Execute-file Commands

执行文件只允许以下 mutation：

| command | payload 的关键输入 | 运行含义 |
| --- | --- | --- |
| `behavior.campaign.start` | `campaignId`、`scenarioId`；可选 root/name/capabilities | 开始本次 campaign history。 |
| `behavior.scenario.activate` | `scenarioId`、`rootId`；可选 `activations`（每项使用 `id`、`variantId`）/`evidenceCapture` | 激活唯一 Scenario。 |
| `behavior.evidence.capture` | `campaignId`、`captureId` | 执行已声明 capture。 |
| `behavior.trigger.invoke` | `triggerCommandId`；可选 `scenarioId`、`params` | 执行唯一 trigger。 |
| `behavior.scenario.deactivate` | `scenarioId` | 移除 Scenario 和 rules，不停止 campaign。 |
| `behavior.campaign.stop` | `campaignId` | 停止 campaign，不移除 Scenario 或 rules。 |

- `capabilities` 由调用方自行去重；Runtime 当前不保证自动去重。
- capture declaration 同时使用 `match` 和 `fields` 时，`fields` 必须包含全部 match 字段。
- deactivate 和 stop 生命周期相互独立，因此执行文件必须同时包含并保持该顺序。

### Scenario Evidence Capture

`behavior.scenario.activate.payload.evidenceCapture` 是对象，不是数组：

```json
{
  "enabled": true,
  "captures": [
    {
      "captureId": "<capture-id>",
      "sourceId": "<evidence-source-id>",
      "kind": "state_snapshot",
      "fields": ["<field>"]
    }
  ]
}
```

每个 `captures[]` 项必须包含 `captureId`、`sourceId` 和 `kind`；`match`、`fields`、`limit` 按对应 EvidenceSource contract 选填。`behavior.evidence.capture` 只引用这里声明的 `captureId`。
- 某条 mutation 失败后，Runtime 跳过依赖它的普通命令，只继续当前实际状态所需的 deactivate/stop。

## Agent-visible Results

### Query Success

```json
{
  "status": "completed",
  "command": "behavior.node.variants",
  "result": {
    "id": "<node-id>",
    "variants": []
  }
}
```

`result` 是 Runtime command result 的 payload，不包含 `type`、`version` 或 `correlationId`。

### Execute Success

```json
{
  "status": "completed",
  "operation": "execute_file",
  "executedCommands": 7
}
```

成功表示执行文件中的全部命令成功完成，包括 cleanup；不表示 BDD 或 Signal 已匹配。

### Failure

```json
{
  "status": "failed",
  "command": "<command>或省略",
  "error": {
    "code": "<runtime-or-tool-code>",
    "message": "<failure-message>"
  }
}
```

执行文件失败时还会返回 `operation: execute_file`、`executedCommands`，以及首个失败命令从 1 开始的执行序号和命令名。

常见 code：

| code | 含义 |
| --- | --- |
| `invalid_dynamic_tool_input` | 输入形式、路径或 execute-file 内容不合法，尚未开始执行。 |
| `command_not_available` | 当前 Phase 未注册该操作。 |
| `unity_editor_unavailable` | 没有可连接的 Unity Editor；请求人工准备 Editor 后再继续。 |
| `unity_editor_ambiguous` | 可连接的 Unity Editor 不唯一；请求人工保留唯一目标后再继续。 |
| `unity_editor_status_failed` | 无法读取 Editor 可用状态或版本。 |
| `unity_play_mode_status_failed` | 无法确认 Play Mode 状态。 |
| `unity_play_mode_start_failed` | Editor 未能进入可执行的 Play Mode。 |
| `behavior_schema_unavailable` | 当前挂载中找不到 Behavioral schema。 |
| `websocket_connect_failed` | Runtime 无法建立 Behavioral session。 |
| `behavior_schema_config_failed` | session 无法配置 schema。 |
| `host_command_failed` | Jarvis 宿主命令失败或超时。 |
| `invalid_behavior_result` | 返回值不是当前 request 的唯一有效 result。 |
| 其它 Runtime code | Behavioral handler 返回的原始 `code`，结合 `message` 解读。 |

## Prohibited

- 不传 request envelope、version、correlationId、endpoint、timeout 或 session。
- 不为启动、停止或确认 Play Mode 预先调用 `UnityPipeline`。
- 不通过单条查询入口发送 campaign mutation。
- 不逐条重放 execute-file 中的 mutation。
- 不根据空结果、命令成功或 execute-file 成功自行推断 BDD 结论。

## Exit

- 查询成功并取得当前 payload；或
- execute-file 全部执行并完成 cleanup；或
- 工具返回明确失败，调用方保留结果且不自行补造 Runtime 状态。

---
assetKind: scout.skill
name: tool-rbt-behavior
description: 通过 JarvisBehavior dynamic tool 执行一个 RBT execute-file，或发送一条只读 Behavioral 查询命令。
id: tool-rbt-behavior
version: 0.7.0
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
- `payload` 按本技能的命令约定与 Runtime 返回的 descriptor 填写，不增加 request envelope。
- 当前 Phase 允许哪些查询由 RBT Domain 决定；本技能不按角色分配权限。

## Agent Input Boundary

调用方不提供也不会在 Agent 结果中看到：

- request `version`；
- request/result `correlationId`；
- WebSocket endpoint 和 session ID；
- command timeout；
- schema path；
- platform type、version、Adapter 或 transport 参数；
- Jarvis CLI 与宿主 shell 输入输出。

`JarvisBehavior` 在发送 Behavioral 命令前，通过当前 Run 的 Execution System 建立或复用执行平台会话，并等待平台达到可执行状态。调用方直接使用本工具；平台准备失败时，消费工具返回的 `error.code` 和 `error.message`。

## Read-only Commands

| command | payload 的关键输入 | 成功结果主要读取 |
| --- | --- | --- |
| `behavior.registry.nodes` | RBT 查询须同时提供 `domain`、`category` | 当前筛选范围内的 `nodes` descriptors。 |
| `behavior.node.variants` | `id` | 该 node 的 `variants` 和 `paramsSchema`。 |
| `behavior.evidence.sources` | `{}` | `sources`、kind 与 query capabilities。 |
| `behavior.trigger.commands` | `{}` | trigger identities、`paramsSchema` 与 `resultSchema`。 |
| `behavior.campaign.query` | 当前 schema 支持的 campaign/Journal filters | `campaigns`；请求包含 evidence 时读取 historical `evidence`。 |
| `behavior.evidence.query` | `sourceId`；可选 kind、match、fields、limit、sinceSequence 等 | 当前 live source 返回的 `evidence`。 |

空数组是有效成功结果，表示当前过滤条件下没有数据；不能自动解释为命令失败。

### Query Constraints

- `behavior.registry.nodes` 必须同时传入已确定的 `domain`、`category`，使用 Runtime 实际分类名称；禁止空 payload 或省略其中一个字段来扩大查询。
- identity、variant、operator、field 和参数只能使用当前查询实际返回的 descriptor。
- `behavior.evidence.query` 的 `sinceSequence` 针对 live record 自身的 sequence，不是 Campaign Journal cursor；当前 source 若返回 `sequence: 0`，传 `sinceSequence: 0` 会将其过滤掉。
- 同时使用 `match` 和 `fields` 时，`fields` 必须包含全部 match 字段；Runtime 会在投影结果上再次执行 match，缺字段可能得到意外空结果。
- `limit: 0` 会成功返回空结果。
- `behavior.campaign.query` 的 campaign `evidenceCount` 是完整 Journal 数量，不一定等于过滤后的 `evidence.length`。
- 同一 execution identity、command 和 payload 已取得成功结果后复用该结果；Runtime 没有报告状态变化时不得重复发送相同查询。失败后的处理只遵循调用方 Domain Skill 的重试边界。

## Execute-file Commands

执行文件只允许以下 mutation：

| command | payload 的关键输入 | 运行含义 |
| --- | --- | --- |
| `behavior.campaign.start` | `campaignId`、`scenarioId`；可选 root/name/capabilities | 开始本次 campaign history。 |
| `behavior.scenario.activate` | `scenarioId`、`rootId`；可选 `activations`（每项使用 `id`、`variantId`）/`evidenceCapture` | 激活唯一 Scenario。 |
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
      "nodeId": "<node-id>",
      "timing": "<before|after|error>",
      "sourceId": "<evidence-source-id>",
      "kind": "state_snapshot",
      "fields": ["<field>"]
    }
  ]
}
```

每个 `captures[]` 项必须包含 `captureId`、`nodeId`、`timing`、`sourceId` 和 `kind`；`timing` 只接受 `before | after | error`，表示在整个 `nodeId` 的对应执行边界采集。`variantId` 只在该 capture 必须限定到该 Node 的某个已注册 Variant 时填写；没有此限定时应省略。`match`、`fields`、`limit` 按对应 EvidenceSource contract 选填。Runtime 在指定 Node 的实际执行边界自动采集，execute-file 不发送独立 capture 命令。
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

### Tool or Platform Failure

```json
{
  "status": "failed",
  "error": {
    "code": "<tool-or-platform-code>",
    "message": "<failure-message>"
  }
}
```

输入、Phase 或执行平台准备失败时使用该结构，此时尚未发送 Behavioral command。

### Query Failure

```json
{
  "status": "failed",
  "command": "<command>",
  "error": {
    "code": "<command-or-runtime-code>",
    "message": "<failure-message>"
  }
}
```

### Execute-file Failure

```json
{
  "status": "failed",
  "operation": "execute_file",
  "executedCommands": 0,
  "error": {
    "sequence": 0,
    "command": "<command>",
    "code": "<execution-code>",
    "message": "<failure-message>"
  }
}
```

`sequence` 是首个失败位置。执行前 identity preflight 失败时为 `0`；命令执行失败时从 `1` 开始。`executedCommands` 是实际发送过的 execute-file command 数量。

稳定 code：

| code | 含义 |
| --- | --- |
| `invalid_dynamic_tool_input` | 输入形式、路径或 execute-file 内容不合法，尚未开始执行。 |
| `command_not_available` | 当前 Phase 未注册该操作。 |
| `execution_platform_unavailable` | 没有识别到可用于当前执行的平台。 |
| `execution_platform_ambiguous` | 同时识别到多个执行平台，无法确定唯一目标。 |
| `execution_platform_unsupported` | 当前执行适配器尚不支持该平台类型。 |
| `execution_system_disposed` | 当前 Run 的 Execution System 已结束，不再接受平台操作。 |
| `identity_preflight_failed` | execute-file 中的 Node、Variant、Evidence Source 或 Trigger identity 与当前 Runtime registry 不一致。 |
| `behavior_schema_unavailable` | 当前挂载中找不到 Behavioral schema。 |
| `websocket_endpoint_conflict` | Behavioral endpoint 已被其它 session 占用。 |
| `websocket_connect_failed` | Runtime 无法建立 Behavioral session。 |
| `websocket_status_unconfirmed` | 建立连接后无法确认 Behavioral session 状态。 |
| `behavior_schema_config_failed` | session 无法配置 schema。 |
| `host_command_failed` | Jarvis 宿主命令失败或超时。 |
| `invalid_behavior_result` | 返回值不是当前 request 的唯一有效 result。 |
| `campaign_history_write_failed` | command 已执行，但对应 campaign history 未能写入。 |
| `behavior_command_failed` | Behavioral command 失败且没有提供更具体的 code。 |
| 其它 Runtime code | Behavioral handler 返回的原始 `code`，结合 `message` 解读。 |

当前 Execution Adapter 可以返回额外的平台专属 code。`JarvisBehavior` 不转换这类失败，直接将原始 `code` 和 `message` 放入 Tool or Platform Failure；调用方不得由 code 名称推断未返回的平台状态。

## Prohibited

- 不传 request envelope、version、correlationId、endpoint、timeout 或 session。
- 不通过单条查询入口发送 campaign mutation。
- 不逐条重放 execute-file 中的 mutation。
- 不根据空结果、命令成功或 execute-file 成功自行推断 BDD 结论。

## Exit

- 查询成功并取得当前 payload；或
- execute-file 全部执行并完成 cleanup；或
- 工具返回明确失败，调用方保留结果且不自行补造 Runtime 状态。

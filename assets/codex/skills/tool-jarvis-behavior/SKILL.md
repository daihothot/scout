---
assetKind: scout.skill
name: tool-jarvis-behavior
description: 通过 Jarvis WebSocket 会话调用本技能已定义的 Behavioral 控制面命令，并检查请求、返回值、副作用和失败时使用。
id: tool-jarvis-behavior
version: 0.2.1
type: tool
family: [tool, jarvis, behavior]
tags: [jarvis, websocket, behavioral, control]
devices: [any]
dependencies:
  skills:
    required: [tool-jarvis-websocket, tool-jarvis-codebase]
summary: 规范 Jarvis Behavioral 控制面的命令请求、结果检查、副作用和重试边界。
---

# Jarvis Behavior Tool

当前 task 已经明确要求调用一个 Jarvis Behavioral command 时，使用本技能完成该命令调用。

使用本技能时，你只负责确认调用条件、发送一个调用方已经选定的命令、检查该命令的真实结果，并报告副作用或失败。命令之间如何组合、以什么顺序执行、结果如何形成业务判断，由当前 Domain Skill 决定。

## Skill Type

- type: tool
- layout: compact
- note: 提供彼此独立的 Jarvis Behavioral command contract，不定义这些命令之间的工作流。

## Core Use

使用本技能处理：

- 使用 `tool-jarvis-websocket` 建立 Behavioral 控制面所需的 WebSocket session。
- 在已连接的 session 上配置 Behavioral callable schema，并调用 `behavior-control` operation。
- 调用一个已经明确选择的 Behavioral command。
- 检查该命令的输入、输出、副作用、失败和重试边界。

职责边界：本技能拥有 Behavioral command 的请求、返回、副作用和失败 contract；BDD 选择、命令组合、业务判断和报告由 Domain / Role Skill 负责。

## Inputs

### I-001: Behavioral Command Request
---

Required：调用方选定的 command、当前已连接 session、符合 schema 的完整 request、非空 `correlationId`。

Optional：当前 Runtime 查询返回的 identity 或 metadata，用于填写和核对 `campaignId`、`scenarioId`、`rootId`、`triggerCommandId`、`sourceId`、`captureId`、`id`、`variantId` 等实际值。

Missing：command、session、schema 必填字段或 identity 缺失时停止调用；不得用示例占位值代替。

Confirmation：发送前确认 request 通过当前 schema；返回后确认结果信封与 request 的 command 和 correlationId 配对，并按实际 payload 报告。

## Behavioral Command Model

Behavioral 控制面的 Jarvis schema operation 和 Runtime JSON-RPC method 分别是：

```text
Jarvis schema operation: behavior-control
Runtime JSON-RPC method: behavior.control
```

Behavioral operation 的 callable schema 固定来自 `gurusdk-unity` managed codebase：

```text
<gurusdk-unity-codebase-root>/gurusdk-framework/contracts/schemas
```

`gurusdk-unity` managed codebase 的默认位置语义是：

```text
~/.guru/codebase/gurusdk-unity
```

不要把默认位置或当前用户名硬编码成绝对路径。先通过 `scout-assets` 取得 required `tool-jarvis-codebase`，再按该 Tool Skill 的 contract 解析当前环境的绝对路径：

```bash
scout-assets skill tool-jarvis-codebase
jarvis codebase gurusdk-unity path
```

将第二条命令返回的绝对路径记为 `<gurusdk-unity-codebase-root>`，再追加固定相对路径 `gurusdk-framework/contracts/schemas`，得到 `<behavior-schema-path>`。该目录是本技能执行 `jarvis ws schema list`、`jarvis ws config.schema` 和每次 `jarvis ws schema call` 使用的同一条路径。不得再到 Scout、Unity Showcase、Jarvis、`specs` 或相邻目录搜索替代 schema。

以下路径不是可替代的 callable schema：

- `contracts/schemas/behavioral/behavior-control.schema.json` 是协议 fragment，单独加载不会列出 callable operation。
- `contracts/schemas/websocket` 单独加载时缺少它引用的 Behavioral schema base。

本技能定义以下彼此独立的 command contract：

```text
behavior.campaign.start
behavior.node.variants
behavior.evidence.sources
behavior.scenario.activate
behavior.trigger.invoke
behavior.campaign.query
behavior.evidence.query
behavior.evidence.capture
behavior.scenario.deactivate
behavior.campaign.stop
```

当前 callable schema 是 Runtime 支持哪些 Behavioral command 的真相源。本技能只定义上述 command；schema 中存在但本技能没有定义的其它 command，不得因此解释为 Runtime 不支持。需要调用未定义的 command 时，先取得对应 Tool Skill contract，不能照相似 command 猜输入和结果。

| command | 类型 | 必填 payload |
| --- | --- | --- |
| `behavior.campaign.start` | 写入 | `campaignId` |
| `behavior.node.variants` | 只读 | `id` |
| `behavior.evidence.sources` | 只读 | 无 |
| `behavior.scenario.activate` | 写入 | `scenarioId`、`rootId` |
| `behavior.trigger.invoke` | 写入 | `triggerCommandId` |
| `behavior.campaign.query` | 只读 | 无 |
| `behavior.evidence.query` | 只读 | `sourceId` |
| `behavior.evidence.capture` | 写入 | `campaignId`、`captureId` |
| `behavior.scenario.deactivate` | 写入 | `scenarioId` |
| `behavior.campaign.stop` | 写入 | `campaignId` |

以下名称表示调用时必须从当前上下文取得的实际值：

- `behavior-command` 表示调用方从本技能支持范围中选定的一个 command。
- `correlation-id` 表示当前请求使用的非空关联值。
- `request-json` 表示符合当前 schema 的完整请求信封。
- `result-code` 表示 Runtime 返回的实际结果码。

`campaignId`、`scenarioId`、`rootId`、`triggerCommandId`、`sourceId`、`captureId`、`id`、`variantId`、参数和字段名称必须来自当前 schema、当前 task 的正式输入，或当前 Runtime 查询返回的实际 identity；不得从示例或名称猜测。

本文 JSON 示例中的 `<campaign-id>`、`<scenario-id>`、`<node-id>`、`<source-id>`、`<field>` 等值只表示字段位置。它们不是可直接发送的默认值；调用前必须替换为当前 schema 或 task 中的真实值。

## Behavioral Invocation Contract

每次 Behavioral command 调用都先使用 required `tool-jarvis-websocket` 建立 session。连接成功后，本技能接管该 session，并将 operation 固定为：

```text
behavior-control
```

`endpoint` 和 `session-id` 交给 `tool-jarvis-websocket`；它只返回已经连接到目标 endpoint 的 session。callable schema、operation、timeout、调用和返回处理全部由本技能负责。

下列调用示例中的 `<session-id>` 表示 `tool-jarvis-websocket` 已建立并验证的实际 session identity。

使用固定 schema 根目录确认 `behavior-control` operation：

```bash
jarvis ws schema list --schema "<behavior-schema-path>"
```

`schema list` 必须成功，并且 operation 列存在唯一的 `behavior-control`。失败时不得搜索或尝试其它路径。

session 连接成功后，由本技能为该 session 配置同一份 schema：

```bash
jarvis ws config.schema --session "<session-id>" \
  --schema "<behavior-schema-path>"
jarvis ws status --session "<session-id>"
```

只有 status 同时确认 session 已连接到输入 endpoint，且 schema 是上述固定目录时，才能调用 Behavioral command。

请求信封固定为：

```json
{
  "type": "<behavior-command>",
  "version": 1,
  "correlationId": "<correlation-id>",
  "payload": {}
}
```

一次 operation 调用只发送一个请求信封。下列命令展示本技能如何使用已连接并配置 schema 的 session：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '<request-json>' --timeout-ms 10000
```

`--timeout-ms 10000` 是本文示例值；实际 timeout 由当前 Behavioral command contract 决定。

结果信封固定为：

```json
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok | error",
  "code": "<result-code>",
  "payload": {}
}
```

`schema call` 退出状态为零且输出包含完整、可解析的 `[RESULT]` JSON，才能形成 transport success。取得结果后，记录 Behavioral command 成功前必须同时确认：

- `type` 是 `behavior.command.result`。
- `version` 是 `1`。
- 返回的 `correlationId` 与请求一致。
- `status` 是 `ok`，`code` 是 `ok`。
- 命令特有 `payload` 支持你要报告的调用结果。

所有 command 都先经过 Runtime DebugMode gate。DebugMode 未开启时，Runtime 可以在读取请求 `correlationId` 前返回：

```text
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "",
  "status": "error",
  "code": "debug_required",
  "payload": {
    "message": "DebugMode is required to use behavior control."
  }
}
```

解读：

- `status: error` 和 `code: debug_required` 表示 command 没有进入自己的 handler。
- 这里空 `correlationId` 是 Runtime gate 的真实结果，不能改写为请求值，也不能把它当作另一条 command 的返回。
- 其它 command error 同样使用 `status: error`，并在 `payload.message` 提供直接错误信息；命令特有字段是否同时返回，以实际 payload 为准。
- 如果请求先被 Jarvis callable schema 拒绝，它不会到达 Runtime，也不会产生 `behavior.command.result`；必须保留本地 schema validation failure，不能补成 `parse_error`。

查询和 capture 声明共用以下字段语义：

- 同时提供 `kind` 与 `kinds` 时，Runtime 将两者合并并去重。
- `match` 中直接写标量等价于 `op: eq`；对象形式必须包含 `op` 和 `value`，当前 operator 是 `eq`、`contains` 或 `regex`。
- 当前内置 EvidenceSource 先在完整 `data` 上执行 `match`，再按 `fields` 投影；Gateway 随后会在投影后的 `data` 上再次执行相同的 `match`。同时使用 `match` 和 `fields` 时，`fields` 必须包含 `match` 使用的全部字段，否则 query 或 capture 可能返回空数组；不需要保留这些字段时，不要传 `fields`。
- `sinceSequence: n` 只保留 `sequence > n` 的记录，不包含第 `n` 条。
- `behavior.evidence.query` 的 `sinceSequence` 只读取 live Source 自己提供的 `sequence`，不是 Campaign Journal cursor。当前内置 live EvidenceSource 不分配 `sequence`，返回值为 `0`；使用 `sinceSequence: 0` 或更大值会过滤掉这些记录。需要按 Journal sequence 查询时，使用 `behavior.campaign.query`。
- `limit: 0` 是合法输入，表示最多返回零条记录；空结果仍是成功的查询或 capture 结果。

## Command Contracts

下列每个命令都是独立 contract，文档中的位置不表示执行顺序。请求和返回示例只展示结构；尖括号占位值必须替换后才能调用。

### `behavior.campaign.start`

使用场景：

- 调用方要求创建一个 evidence campaign 时使用。

输入：

- 必填 `campaignId`。
- 可选 `scenarioId`、`rootId`、`name` 和 `capabilities`。调用方应自行去除重复的 capability；Runtime 当前只过滤空字符串，不会自动去重。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.campaign.start",
    "version": 1,
    "correlationId": "<correlation-id>",
    "payload": {
      "campaignId": "<campaign-id>",
      "scenarioId": "<scenario-id>",
      "rootId": "<root-node-id>",
      "name": "<campaign-name>"
    }
  }' --timeout-ms 10000
```

输出：

- 成功 `payload` 包含请求的 `campaignId` 和 `status: running`。

返回值示例：

```text
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "campaignId": "<campaign-id>",
    "status": "running"
  }
}
```

解读：

- `payload.campaignId` 确认 Runtime 启动的是请求中的 campaign。
- `payload.status: running` 表示新 campaign 对象当前可接收 Journal evidence；它不表示 scenario 已激活或测试已经开始执行。
- 返回值不包含 `scenarioId`、`rootId`、`name` 或 `capabilities`；需要确认这些 metadata 时必须查询 campaign。

副作用：

- 创建 campaign。
- 复用已有 `campaignId` 会替换原 campaign 对象，不会续接原对象，也不会删除 Journal 中已经使用该 ID 保存的旧 evidence。

退出条件：

- 结果信封有效，`status` 是 `ok`，返回的 `campaignId` 与请求一致，且 `payload.status` 是 `running`。
- 只有满足以上条件，才能报告“campaign 已启动”。
- 请求信封字段缺失或类型无法解析时返回 `parse_error`，不是成功退出。

禁止事项：

- 禁止把复用同一 `campaignId` 当作继续原 campaign。
- 禁止在复用 ID 后把相同 `campaignId` 的全部 historical evidence 自动解释为本次新 campaign 产生。
- 禁止因 transport 超时而自动再次调用。

重试边界：

- 本命令不能自动重试。再次调用前必须检查当前 campaign 状态，并由调用方根据当前状态重新确认。

### `behavior.node.variants`

使用场景：

- 调用方需要查询一个已知 node 当前可用的 variants 和参数 schema 时使用。

输入：

- 必填 `id`，表示当前 schema 中的 BehaviorNode identity。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.node.variants",
    "version": 1,
    "correlationId": "<correlation-id>",
    "payload": {
      "id": "<node-id>"
    }
  }' --timeout-ms 10000
```

输出：

- 成功 `payload` 包含 `id`、`domain` 和 `variants`。
- 每个 variant descriptor 包含实际 `id`、`variantId`、`executionKind`、`description`、`paramsSchema` 和 `fallback`。
- `variants` 可以是空数组。

返回值示例：

```text
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "id": "<node-id>",
    "domain": "<domain>",
    "variants": [
      {
        "id": "<node-id>",
        "variantId": "<variant-id>",
        "executionKind": "<execution-kind>",
        "description": "<variant-description>",
        "paramsSchema": <parameter-schema-object>,
        "fallback": "<fallback>"
      }
    ]
  }
}
```

解读：

- 顶层 `payload.id` 和每个 descriptor 的 `id` 都必须是被查询的 node。
- `variantId` 只在该 node 内有意义；调用方必须按对应 `paramsSchema` 准备参数。
- `executionKind`、`paramsSchema` 和 `fallback` 都使用 Runtime 返回的实际值；示例不预设具体执行形态、参数类型或 fallback。
- `variants: []` 只表示 node 当前没有注册 variant；它与 `node_not_found` 不同。

副作用：

- 无；本命令只读取当前 Runtime 中可见的 variant 注册事实。

退出条件：

- 结果信封有效，`status` 是 `ok`，返回的 `id` 与请求一致，且 `variants` 是可读取的数组。
- `debug_required` 表示当前 Runtime 模式不允许查询；`node_not_found` 表示目标 node 不存在。两者都不是成功退出。
- 请求中的 `id` 无法解析时返回 `parse_error`，不是空 variants。

禁止事项：

- 禁止补造未返回的 `variantId` 或参数。
- 禁止把空 `variants` 解释为 node 不存在，也禁止把错误结果改写为空列表。

重试边界：

- 只有前一次是 transport 失败时，才可以使用完全相同的 `id` 和 `correlationId` 重试一次只读查询；收到 Runtime result 后不得用重试改写结果。

### `behavior.evidence.sources`

使用场景：

- 调用方需要读取当前 Runtime 已注册的 EvidenceSource identity 和 query capabilities 时使用。

输入：

- `payload` 必须是空 object。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.evidence.sources",
    "version": 1,
    "correlationId": "<correlation-id>",
    "payload": {}
  }' --timeout-ms 10000
```

输出：

- 成功 `payload.sources` 是当前已注册 source descriptors 的 array，可以为空。
- 每个 descriptor 包含 `sourceId`、`kind`、`domain`、`category`、`segments`、`description`、`passiveOnly`、`canTrigger` 和 `queryCapabilities`。
- `queryCapabilities` 包含 source 级 `operators`、`fields` 和 `supportsFieldSelection`；每个 field descriptor 包含 `name`、`description`、`kind`、`nullable`、`filterable`、`selectable`、`operators` 和可选 `example`。

返回值示例：

```text
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "sources": [
      {
        "sourceId": "<source-id>",
        "kind": "<evidence-kind>",
        "domain": "<domain>",
        "category": "<category>",
        "segments": ["<segment>", ...],
        "description": "<source-description>",
        "passiveOnly": <boolean>,
        "canTrigger": <boolean>,
        "queryCapabilities": {
          "operators": ["<operator>", ...],
          "fields": [
            {
              "name": "<field>",
              "description": "<field-description>",
              "kind": "<field-kind>",
              "nullable": <boolean>,
              "filterable": <boolean>,
              "selectable": <boolean>,
              "operators": ["<operator>", ...]
            }
          ],
          "supportsFieldSelection": <boolean>
        }
      }
    ]
  }
}
```

解读：

- `sourceId` 和 `kind` 确认 source identity 与它产生的 evidence 类型。
- `passiveOnly`、`canTrigger` 描述 source 自身能力；它们不表示本次已经查询或采集。
- `operators`、field descriptors 和 `supportsFieldSelection` 必须读取实际返回；示例不预设 source 支持哪种 operator、字段类型或选择能力。
- filter operator 必须受 source 级 `operators` 支持；descriptor 已列出目标 field 时，还必须满足该 field 的 `filterable/operators`。descriptor 没有列出字段时，Gateway 不会仅凭这一点拒绝，最终是否有结果由 source 自己决定。
- 字段选择要求 `supportsFieldSelection: true`；descriptor 已列出目标 field 时还要求 `selectable: true`。descriptor 没有列出字段时，实际 source 可能忽略它，因此只能按真实返回的 `data` 判断。
- `sources: []` 是成功返回，只表示当前 registry 没有 source descriptor。

副作用：

- 无；本命令只读取 EvidenceSource registry。

退出条件：

- 结果信封有效，`status` 是 `ok`，且 `payload.sources` 是可读取的 array。
- 空 array 是有效结果，只表示当前 registry 没有返回 source。
- `debug_required` 是 error result，不是空 registry。

禁止事项：

- 禁止根据 source ID 文本猜测未返回的字段、operator、kind 或 query capability。
- 禁止把 source descriptor 存在解释为已经产生 evidence。

重试边界：

- 只有前一次是 transport 失败时，才可以使用完全相同的请求和 `correlationId` 重试一次；收到 Runtime result 后不得通过重试替换空结果。

### `behavior.scenario.activate`

使用场景：

- 调用方要求激活一个 scenario，写入一组 node variants 或启用被动 evidence capture 时使用。

输入：

- 必填 `scenarioId` 和 `rootId`。
- 可选 `activations`；每项可以包含 `id`、`variantId`、`source`、`params` 和 `ttlMs`。
- 每个 activation 必填 `id` 和 `variantId`；`source`、`params`、`ttlMs` 可选，同一 node 不能重复声明。
- 可选 `evidenceCapture`；可以声明 `enabled`、`kinds`、`sources` 和 `captures`。每个 capture 必填唯一的 `captureId`、已注册的 `sourceId` 和与 source 一致的 `kind`，并可选 `match`、`fields` 和非负 `limit`。
- 一个 capture 同时声明 `match` 和 `fields` 时，`fields` 必须包含 `match` 使用的全部字段；否则执行 `behavior.evidence.capture` 时可能得到空数组。不需要保留这些匹配字段时，不要声明 `fields`。
- `enabled` 默认是 `false`。声明 `captures` 但没有设为 `true` 时，capture 配置会保存在 scenario 中，但 `behavior.evidence.capture` 会以 `validation_failed` 拒绝执行。
- `activations` 可以为空，此时 scenario 可以只负责被动 evidence capture。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.scenario.activate",
    "version": 1,
    "correlationId": "<correlation-id>",
    "payload": {
      "scenarioId": "<scenario-id>",
      "rootId": "<root-node-id>"
    }
  }' --timeout-ms 10000
```

该示例只发送必填字段，不预设当前 scenario 是主动 activation、被动 capture，还是两者同时使用。需要可选配置时，按上方输入 contract 使用当前 task 已经选定的实际值。

输出：

- 成功 `payload` 包含 `scenarioId`、`rootId`、`isPassive` 和 `activationCount`。

返回值示例：

```text
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "scenarioId": "<scenario-id>",
    "rootId": "<root-node-id>",
    "isPassive": <boolean>,
    "activationCount": <non-negative-integer>
  }
}
```

解读：

- `activationCount` 只统计实际写入的 node activation 数量。
- `isPassive: true` 的精确含义是 `activationCount` 为零且 `evidenceCapture.enabled` 为 `true`。
- 示例不预设当前 scenario 是否 passive 或包含多少条 activation；必须读取实际布尔值和数量。
- 返回值确认 scenario 已保存；它不证明 capture 已执行，也不证明任何业务 node 已运行。

副作用：

- 将 activation 对应的规则写入 Runtime rule store。
- 将 scenario 写入 Runtime scenario store，并可能启用 evidence capture。
- 同一 `scenarioId` 仍处于 active 时，Runtime 直接替换该 scenario state，不会先移除旧 scenario 已写入但本次 activation 未覆盖的 rule；不能把复用 active ID 当作干净重建。

退出条件：

- 结果信封有效，`status` 是 `ok`，返回的 `scenarioId` 和 `rootId` 与请求一致，`activationCount` 与请求中的 activation 数量一致。
- 只有满足以上条件，才能报告“scenario 已激活”。
- `node_not_found`、`variant_not_found`、`variant_node_mismatch`、`duplicate_node_activation`、`validation_failed` 或 `parse_error` 都表示 scenario 未成功激活。

禁止事项：

- 禁止使用当前 schema 或实际 capability 查询中不存在的 node、variant、source 或 kind。字段筛选和选择必须按 source descriptor 与 source 的真实返回处理，不能从相似 source 猜测。
- 禁止在未先停用 active scenario 的情况下复用同一 `scenarioId`，如果调用方要求干净重建，应先由 Domain 流程安排 `behavior.scenario.deactivate`。
- 禁止把 `activationCount`、`isPassive` 或 transport 成功解释为业务行为已经发生或 evidence 已经产生。
- 禁止用 disconnect 代替 scenario cleanup。

重试边界：

- 本命令不能自动重试。transport 失败后必须先检查当前 Runtime 状态，并由调用方重新确认是否再次激活。

### `behavior.trigger.invoke`

使用场景：

- 调用方要求执行一个当前 schema 已注册的 trigger command 时使用。

输入：

- 必填 `triggerCommandId`。
- 可选 `scenarioId`。
- `params` 使用当前 trigger command schema 要求的对象；没有参数时使用空对象。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.trigger.invoke",
    "version": 1,
    "correlationId": "<correlation-id>",
    "payload": {
      "triggerCommandId": "<trigger-command-id>",
      "scenarioId": "<scenario-id>",
      "params": {}
    }
  }' --timeout-ms 10000
```

输出：

- Runtime 直接返回当前 trigger 的 `code` 和 `payload`；具体字段由该 trigger command 的当前 contract 决定。

返回值示例：

```text
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
      "<result-field>": <result-json-value>
  }
}
```

解读：

- `payload` 不是统一固定结构，必须按当前 trigger descriptor 的 `resultSchema` 解释。
- `status: ok` 表示 trigger command 自己报告调用成功；它不表示 BDD、Signal expectation 或其它业务断言成立。
- 未注册的 `triggerCommandId` 返回 `status: error`、`code: unsupported`；参数解析或 trigger 自身失败必须保留其实际 `code` 和 `payload.message`。

副作用：

- 主动执行已注册 trigger，可能产生不可重复的业务副作用。

退出条件：

- 结果信封有效，`correlationId` 匹配，并已完整保留 Runtime 返回的 `status`、`code` 和 `payload`。
- 只有 `status` 和 `code` 都是 `ok` 时，才能报告 trigger command 调用成功；本技能不能据此判断业务测试通过。
- `unsupported` 表示 trigger 未注册；`debug_required` 表示当前 gate 不允许调用；`parse_error` 或 trigger 返回的其它 error code 必须按原值报告。

禁止事项：

- 禁止使用相似名称替代未注册的 `triggerCommandId`。
- 禁止因未看到预期业务结果而自行改变 `params` 再次调用。
- 禁止把 CLI 成功、transport 成功或 trigger 调用成功直接写成 pass。

重试边界：

- 本命令不能自动重试。transport 失败时执行是否已经发生可能未知，必须保留该事实并等待调用方重新确认。

### `behavior.campaign.query`

使用场景：

- 调用方要求读取 campaign metadata，或读取 campaign 保存的 historical evidence journal 时使用。

输入：

- 可选 `campaignId`、`scenarioId`、`correlationId`、`id`、`variantId`、`result`、`sourceId`、`captureId`、`kind`、`kinds`、`match`、`sinceSequence` 和 `limit`。
- 可选 `includeEvidence`；为 `true` 时返回符合过滤条件的 campaign journal。
- 空 `payload` 表示不使用过滤条件查询当前 campaigns。
- `campaignId` 和 `scenarioId` 同时用于筛选 `campaigns`；其它 Journal 条件只在 `includeEvidence: true` 时筛选 `evidence`，不改变 `campaigns`。`limit` 也只限制 `evidence` 数量。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.campaign.query",
    "version": 1,
    "correlationId": "<query-correlation-id>",
    "payload": {
      "campaignId": "<campaign-id>",
      "includeEvidence": true
    }
  }' --timeout-ms 10000
```

输出：

- 成功 `payload.campaigns` 是匹配的 campaign 列表。
- `includeEvidence` 是 `true` 时，`payload.evidence` 是匹配的 historical journal；否则该字段可以不存在。
- `campaigns` 或 `evidence` 可以是空数组。

返回值示例：

```text
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<query-correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "campaigns": [
      {
        "campaignId": "<campaign-id>",
        "scenarioId": "<scenario-id>",
        "rootId": "<root-node-id>",
        "name": "<campaign-name>",
        "status": "<campaign-status>",
        "startedAt": "<utc-timestamp>",
        "stoppedAt": "<utc-timestamp-or-empty>",
        "capabilities": ["<capability>", ...],
        "evidenceCount": <non-negative-integer>
      }
    ],
    "evidence": [
      {
        "campaignId": "<campaign-id>",
        "scenarioId": "<scenario-id>",
        "correlationId": "<origin-correlation-id>",
        "traceId": "<trace-id>",
        "parentTraceId": "<parent-trace-id>",
        "sequence": <non-negative-integer>,
        "timestamp": "<utc-timestamp>",
        "kind": "<evidence-kind>",
        "sourceId": "<source-id-or-empty>",
        "captureId": "<capture-id-or-empty>",
        "id": "<node-id>",
        "variantId": "<variant-id-or-empty>",
        "result": "<result>",
        "fallbackReason": "<fallback-reason-or-empty>",
        "error": "<error-or-empty>",
        "data": <evidence-data-object>
      }
    ]
  }
}
```

解读：

- 顶层 `correlationId` 属于本次 query command；evidence 内的 `correlationId` 属于产生该 record 的命令或调用，两者不能混用。
- `campaigns[].status`、时间、capabilities、evidenceCount 以及每条 evidence 的 sequence 都使用实际返回；示例不预设 campaign 生命周期或 Journal 数量。
- `campaigns[].evidenceCount` 是该 campaign 在完整 Journal 中的总数，不受本次 Journal filter 或 `limit` 影响。
- `payload.evidence` 只有请求 `includeEvidence: true` 时才存在；其中每项是已保存的 historical RuntimeEvidence。
- `campaigns: []` 或 `evidence: []` 都是成功结果，分别表示没有匹配的 campaign metadata 或 Journal record。

副作用：

- 无；本命令只读取 campaign store。

退出条件：

- 结果信封有效，`status` 是 `ok`，`campaigns` 是可读取的数组；请求 `includeEvidence: true` 时还必须检查 `evidence` 数组。
- 空数组是有效查询结果，不得改写成 transport 或 Runtime 失败。
- 请求字段无法解析或 `match` operator 无效时返回 `parse_error`，不是空查询结果。

禁止事项：

- 禁止把 campaign historical journal 当作 `behavior.evidence.query` 返回的 live source result。
- 禁止从空结果推断 campaign 从未存在，除非当前查询条件足以支持该结论。

重试边界：

- 只有前一次是 transport 失败时，才可以使用完全相同的请求和 `correlationId` 重试一次；收到 Runtime result 后不得用重试替换空结果或错误结果。

### `behavior.evidence.query`

使用场景：

- 调用方要求读取一个当前已注册的 live evidence source 时使用。

输入：

- 必填 `sourceId`。
- 可选 `scenarioId`、`captureId`、`kind`、`kinds`、`match`、`fields`、`sinceSequence` 和 `limit`。
- filter、operator 和字段选择必须受当前 source 的 query capabilities 支持。
- source 负责根据 `fields` 产生投影结果；Gateway 再按 `kind/kinds`、`captureId`、`sinceSequence`、`match` 和 `limit` 过滤 source 返回的 records。
- 同时使用 `match` 和 `fields` 时，`fields` 必须包含 `match` 使用的全部字段；否则 Gateway 在投影结果上再次执行 `match` 时可能返回空数组。不需要保留这些匹配字段时，不要传 `fields`。
- 不要把 live query 的 `sinceSequence` 当作 Campaign Journal cursor；当前内置 live EvidenceSource 的 record `sequence` 为 `0`，因此 `sinceSequence: 0` 或更大值会过滤掉这些记录。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.evidence.query",
    "version": 1,
    "correlationId": "<correlation-id>",
    "payload": {
      "scenarioId": "<scenario-id>",
      "sourceId": "<source-id>",
      "kind": "<evidence-kind>",
      "fields": ["<field>"]
    }
  }' --timeout-ms 10000
```

输出：

- 成功 `payload.evidence` 是当前 live source 返回的 evidence 数组。
- `evidence` 可以是空数组。

返回值示例：

```text
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "evidence": [
      {
        "campaignId": "<campaign-id-or-empty>",
        "scenarioId": "<scenario-id>",
        "correlationId": "<origin-correlation-id-or-empty>",
        "traceId": "<trace-id-or-empty>",
        "parentTraceId": "<parent-trace-id-or-empty>",
        "sequence": <non-negative-integer>,
        "timestamp": "<utc-timestamp>",
        "kind": "<evidence-kind>",
        "sourceId": "<source-id>",
        "captureId": "<capture-id-or-empty>",
        "id": "<node-id-or-empty>",
        "variantId": "<variant-id-or-empty>",
        "result": "<result-or-empty>",
        "fallbackReason": "<fallback-reason-or-empty>",
        "error": "<error-or-empty>",
        "data": {
          "<field>": <actual-json-value>
        }
      }
    ]
  }
}
```

解读：

- 这是 live source result，不是 Campaign Journal record；未写入 campaign 时，`campaignId` 可以为空，`sequence` 使用 source 实际提供的值。
- `data` 的字段和类型由 source 自己定义；请求 `fields` 时，只能依据实际返回判断 source 是否按声明投影。
- `evidence: []` 表示该 source 在本次条件下没有返回 record，不表示 transport 失败，也不自动表示业务失败。

副作用：

- 无；本命令只调用当前注册 source 的 query 能力。

退出条件：

- 结果信封有效，`status` 是 `ok`，且 `evidence` 是可读取的数组。
- 空数组是有效查询结果，不得改写成 transport 或 Runtime 失败。
- source 缺失、不存在、kind 不匹配、filter 或 field selection 不受支持时返回 `validation_failed`；请求无法解析时返回 `parse_error`。这些都不是空 evidence。

禁止事项：

- 禁止把 live source result 当作 campaign historical journal。
- 禁止补造 source 不支持的 filter、operator 或字段。
- 禁止使用 live `sinceSequence` 追踪 Campaign Journal；Journal cursor 只能用于 `behavior.campaign.query`。
- 禁止把空 evidence 数组直接解释为测试失败。

重试边界：

- 只有前一次是 transport 失败时，才可以使用完全相同的请求和 `correlationId` 重试一次；收到 Runtime result 后不得为了得到非空 evidence 而重复查询。

### `behavior.evidence.capture`

使用场景：

- 调用方要求执行一个已在 active scenario 中声明的 EvidenceSource capture，并将其结果写入当前 campaign 时使用。

输入：

- 必填 `campaignId` 和 `captureId`。
- campaign 必须存在且是 `running`；它关联的 scenario 必须仍处于 active 状态，且 `evidenceCapture.enabled` 必须是 `true`。
- 该 `captureId` 必须已由该 scenario 声明，声明引用的 source 必须仍存在。
- 本请求不接受 source、kind、match、fields 或 limit 覆盖；采集配置来自 scenario declaration。
- capture declaration 同时包含 `match` 和 `fields` 时，`fields` 必须包含 `match` 使用的全部字段；本命令不能在调用时修正错误的 declaration。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.evidence.capture",
    "version": 1,
    "correlationId": "<correlation-id>",
    "payload": {
      "campaignId": "<campaign-id>",
      "captureId": "<capture-id>"
    }
  }' --timeout-ms 10000
```

输出：

- 成功 `payload` 包含 `campaignId`、`scenarioId`、`captureId` 和 `evidence`。
- `payload.evidence` 是本次 source query 返回并写入 Campaign Journal 的 RuntimeEvidence array，可以为空。

返回值示例：

```text
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "campaignId": "<campaign-id>",
    "scenarioId": "<scenario-id>",
    "captureId": "<capture-id>",
    "evidence": [
      {
        "campaignId": "<campaign-id>",
        "scenarioId": "<scenario-id>",
        "correlationId": "<correlation-id>",
        "traceId": "<trace-id-or-empty>",
        "parentTraceId": "<parent-trace-id-or-empty>",
        "sequence": <positive-integer>,
        "timestamp": "<utc-timestamp>",
        "kind": "<evidence-kind>",
        "sourceId": "<source-id>",
        "captureId": "<capture-id>",
        "id": "<node-id-or-empty>",
        "variantId": "<variant-id-or-empty>",
        "result": "<result-or-empty>",
        "fallbackReason": "<fallback-reason-or-empty>",
        "error": "<error-or-empty>",
        "data": {
          "<field>": <actual-json-value>
        }
      }
    ]
  }
}
```

解读：

- 顶层 identity 确认本次执行的是哪个 declaration；每条 record 上的同名字段确认它已关联并写入该 campaign。
- Runtime 在写入 Journal 时分配 `sequence` 和 `timestamp`，并把本次 capture command 的 `correlationId` 写入 record。
- `evidence: []` 仍是成功 capture，只表示 source 在该 declaration 的筛选条件下返回零条 record，因此 Journal 没有新增 record。

副作用：

- 查询 capture declaration 指定的 EvidenceSource。
- 对返回 records 写入当前 `campaignId`、`scenarioId`、命令 `correlationId`、source 的 `kind`、`sourceId` 和 `captureId`，再保存到 Campaign Journal。
- 保存时由 campaign store 分配递增 `sequence` 和当前 UTC `timestamp`。
- 返回零条 evidence 时不向 Journal 补写 record。

退出条件：

- 结果信封有效，`status` 是 `ok`，返回的 `campaignId` 和 `captureId` 与请求一致，`scenarioId` 是 campaign 当前关联的 active scenario，且 `evidence` 是 array。
- 空 `evidence` 是成功的 capture 结果，只表示该 declaration 在当前 source 中没有返回 record。
- `campaign_not_found`、`campaign_not_running`、`scenario_not_found`、`capture_not_found`、`validation_failed` 或 `parse_error` 都不是成功退出。

禁止事项：

- 禁止使用本命令改写 capture declaration，或使用未声明的 `captureId`。
- 禁止把命令成功、非空 evidence 或 Journal 写入解释为 Signal 值符合预期。

重试边界：

- 本命令不能自动重试。transport 失败时 capture 可能已经写入 Journal，必须保留执行状态未知，并由调用方重新确认后续行为。

### `behavior.scenario.deactivate`

使用场景：

- 调用方要求移除一个 scenario 及其写入的规则时使用。

输入：

- 必填 `scenarioId`。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.scenario.deactivate",
    "version": 1,
    "correlationId": "<correlation-id>",
    "payload": {
      "scenarioId": "<scenario-id>"
    }
  }' --timeout-ms 10000
```

输出：

- 成功 `payload` 包含请求的 `scenarioId` 和布尔值 `removed`。

返回值示例：

```json
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "scenarioId": "<scenario-id>",
    "removed": true
  }
}
```

解读：

- `removed: true` 表示这次调用找到了 active scenario，并移除了 scenario 及其规则。
- `removed: false` 仍是有效的 `status: ok` 返回，但表示没有找到可移除的 active scenario；不能报告 cleanup 已由本次调用完成。

副作用：

- `removed: true` 时，Runtime 移除该 scenario 及其写入的规则。
- `removed: false` 时，本次调用没有移除 scenario。
- 本命令不会停止或删除关联的 campaign。只停用 scenario 后，仍在运行的关联 campaign 保持 `running`；此时再执行 capture，会因 active scenario 已不存在而返回 `scenario_not_found`。如果 campaign 已先停止，capture 会先返回 `campaign_not_running`。

退出条件：

- 结果信封有效，`status` 是 `ok`，返回的 `scenarioId` 与请求一致，且 `removed` 是布尔值。
- 只有 `removed: true` 时，才能报告“scenario 已移除”；`removed: false` 必须按“没有移除目标”报告。
- 请求缺少合法 `scenarioId` 时返回 `parse_error`；`debug_required` 表示 cleanup command 没有进入 handler。

禁止事项：

- 禁止把 `removed: false` 记录成已完成 cleanup。
- 禁止把 scenario 已移除解释为关联 campaign 已停止。
- 禁止用 disconnect 代替本命令。

重试边界：

- 本命令不能自动重试。再次调用前必须根据 `removed` 和当前 Runtime 状态，由调用方重新确认。

### `behavior.campaign.stop`

使用场景：

- 调用方要求停止一个 campaign 时使用。

输入：

- 必填 `campaignId`。

示例调用：

```bash
jarvis ws schema call behavior-control --schema "<behavior-schema-path>" \
  --session "<session-id>" \
  --params-json '{
    "type": "behavior.campaign.stop",
    "version": 1,
    "correlationId": "<correlation-id>",
    "payload": {
      "campaignId": "<campaign-id>"
    }
  }' --timeout-ms 10000
```

输出：

- 成功 `payload` 包含请求的 `campaignId`、布尔值 `removed` 和 `status`。
- 找到目标时返回 `removed: true`、`status: stopped`。
- 目标不存在时仍可能返回外层 `status: ok`，但 `payload` 是 `removed: false`、`status: missing`。

返回值示例：

```json
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "campaignId": "<campaign-id>",
    "removed": true,
    "status": "stopped"
  }
}
```

目标不存在时的返回值：

```json
{
  "type": "behavior.command.result",
  "version": 1,
  "correlationId": "<correlation-id>",
  "status": "ok",
  "code": "ok",
  "payload": {
    "campaignId": "<campaign-id>",
    "removed": false,
    "status": "missing"
  }
}
```

解读：

- `removed: true` 在这里表示 campaign store 找到了目标，不表示目标在调用前一定是 `running`。
- 对已经是 `stopped` 的 campaign 再次调用，也会返回 `removed: true`、`status: stopped`；因此该返回只能证明调用后状态是 stopped，不能证明本次发生了 running → stopped 转换。
- `removed: false`、`status: missing` 表示 store 中没有该 ID；它不是 protocol error。

副作用：

- `removed: true` 时确保目标 campaign 为 `stopped`；首次从 running 停止时记录停止时间，重复停止保持原状态。campaign 仍保留在 store 中供后续查询。
- `removed: false` 时没有找到可停止的 campaign。
- 本命令不会停用关联的 scenario，也不会移除该 scenario 写入的规则。只停止 campaign 后，仍处于 active 状态的规则仍可能继续影响业务执行。

退出条件：

- 结果信封有效，`status` 和 `code` 都是 `ok`，返回的 `campaignId` 与请求一致，`removed` 和 `payload.status` 彼此一致。
- 只有 `removed: true` 且 `payload.status` 是 `stopped` 时，才能报告“campaign 已停止”。
- `removed: false`、`payload.status: missing` 必须按“目标不存在，没有停止 campaign”报告。
- 请求缺少合法 `campaignId` 时返回 `parse_error`；`debug_required` 表示 stop command 没有进入 handler。

禁止事项：

- 禁止只检查外层 `status: ok` 就报告 campaign 已停止。
- 禁止把 campaign 已停止解释为关联 scenario 或规则已经移除。
- 禁止用 disconnect 代替本命令。

重试边界：

- 本命令不能自动重试。再次调用前必须根据 `removed`、`payload.status` 和当前 Runtime 状态，由调用方重新确认。

## Result Contract

每次调用返回并保留：

- command `type` 和 `correlationId`。
- 完整结果信封中的 `status`、`code` 和 `payload`。
- command 是否改变 Runtime 状态，以及能够从 `payload` 确认的实际结果。
- required `tool-jarvis-websocket` 返回的 session 连接事实。
- 本技能执行 schema discovery、schema 配置和 `schema call` 时产生的实际 transport 状态，或 Behavioral command result 的失败事实。

本技能不生成持久 artifact。当前 Domain Skill 需要保存结果或形成业务结论时，由该 Domain Skill 决定 artifact、引用和解释。

## Evidence Rules (Enforcement)

- ER-001：`behavior.campaign.query` 的 historical journal 与 `behavior.evidence.query` 的 live source result 是不同事实，不能互相替代。
- ER-002：只有当前请求、匹配的结果信封和完整 command `payload` 可以证明本次工具调用结果；Shell 退出状态、连接状态和本文示例不能替代它们。
- ER-003：`behavior.evidence.sources` 只证明当前 source 和 capabilities 注册事实；`behavior.evidence.capture` 只证明实际 capture 调用及其直接返回，两者都不形成 Signal 匹配或 BDD 结论。

## Failure Rules (Enforcement)

- FR-001：`tool-jarvis-websocket` 未形成 connected session 时，必须保留它报告的连接失败，不得进入 schema 配置或 command 调用。
- FR-002：`status: error`、错误 `code` 或不支持声称结果的 `payload` 必须按实际 Behavioral command result 报告。
- FR-003：transport 超时或断开后无法确定 mutating command 是否到达 Runtime 时，必须把执行状态报告为未知。
- FR-004：空查询结果、`removed: false` 和 `status: missing` 是可读取的命令结果，不能统一改写成失败，也不能改写成目标状态已经达成。
- FR-005：`campaign.stop` 的 `removed: true` 不能单独证明本次发生了状态转换；只能确认 store 找到目标且调用后状态是 `stopped`。
- FR-006：`schema list`、`config.schema` 或 `schema call` 失败时，必须按 schema discovery、schema configuration、validation 或 transport 的实际边界报告。
- FR-007：`schema call` 退出状态为零但 `[RESULT]` 缺失、截断或不可解析时，不能形成 transport success。
- FR-008：每次 `schema call` 都必须显式传入当前已解析的 `<behavior-schema-path>`；session 已执行 `config.schema` 不能替代该参数。

## Blocking Rules (Enforcement)

- BR-001：required `tool-jarvis-websocket` 未确认 session 已连接到输入 endpoint，或本技能未从固定 schema 确认唯一的 `behavior-control` operation 时，停止调用。
- BR-002：command identity 不在当前 Behavioral schema 中，当前 command 必填输入缺失，或请求不能通过当前 schema 时，停止调用，不得使用相似名称替代。

## Prohibited Rules (Enforcement)

- PR-001：禁止补造 Runtime identity、command 参数、结果字段或成功状态。
- PR-002：禁止把示例占位值或示例中的枚举取值当作当前 schema、Runtime 或 task 的默认值。
- PR-003：禁止由本技能决定多个 command 的执行顺序、业务目的或 pass / fail。
- PR-004：禁止把 WebSocket disconnect 当作 scenario 或 campaign 的 Runtime cleanup。

## Checklist

- 当前 task 已经明确选择一个本技能支持的 Behavioral command。
- required `tool-jarvis-websocket` 只建立了 session，并已确认它连接到输入 endpoint。
- 本技能使用固定 schema 根目录确认并配置了唯一的 `behavior-control` operation。
- 所有 Runtime identity、字段和参数来自当前 schema 或当前 task 的正式输入。
- 本次 operation 调用只发送一个 command。
- 已核对结果 `type`、`version`、`correlationId`、`status`、`code` 和 command 特有 `payload`。
- 已按当前 command contract 报告输出、副作用、退出状态和失败层次。
- query 空结果、`removed: false`、`status: missing` 和 transport 未知状态没有被改写。
- 重试符合当前 command 的只读性、副作用和重新确认边界。
- WebSocket disconnect 没有被当作 Runtime cleanup。
- 每次 `schema call` 都显式使用当前已解析的 `<behavior-schema-path>`，没有依赖 session 的历史 schema 配置代替 `--schema`。
- 没有决定命令顺序，也没有生成当前 Domain Skill 才能形成的业务结论。

---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 同版本可重放 execute-file.json contract。
artifact_type: RBTExecuteFileTemplate
artifact_version: 1
---

# Execute File

执行文件位于：

```text
${SCOUT_ARTIFACT_ROOT}/<bdd-id>/<version>/execute-file.json
```

相邻的 `${SCOUT_ARTIFACT_ROOT}/<bdd-id>/<version>/execute-pack/` 保存 Agent 证据和预期。

## File Contract

```json
{
  "commands": [
    {
      "command": "behavior.campaign.start",
      "payload": {
        "campaignId": "<bddScenarioId>/campaign/main",
        "scenarioId": "<bddScenarioId>"
      }
    },
    {
      "command": "behavior.scenario.activate",
      "payload": {
        "scenarioId": "<bddScenarioId>",
        "rootId": "<rootId>",
        "activations": [
          {
            "id": "<nodeId>",
            "variantId": "<variantId>",
            "params": {}
          }
        ],
        "evidenceCapture": {
          "enabled": true,
          "captures": [
            {
              "captureId": "<captureId>",
              "sourceId": "<sourceId>",
              "kind": "state_snapshot",
              "fields": ["<field>"]
            }
          ]
        }
      }
    },
    {
      "command": "behavior.trigger.invoke",
      "payload": {
        "scenarioId": "<bddScenarioId>",
        "triggerCommandId": "<triggerCommandId>",
        "params": {}
      }
    },
    {
      "command": "behavior.scenario.deactivate",
      "payload": {
        "scenarioId": "<bddScenarioId>"
      }
    },
    {
      "command": "behavior.campaign.stop",
      "payload": {
        "campaignId": "<bddScenarioId>/campaign/main"
      }
    }
  ]
}
```

`bdd-id` 和目标版本只由文件路径确定，不重复写入 JSON。命令顺序由 `commands` 数组位置确定，不增加 `sequence` 字段。

## Sequence Boundary

- 第一条必须是唯一的 `behavior.campaign.start`。
- 随后必须有唯一的 `behavior.scenario.activate`。
- 中间按最终计划放置零个或多个 `behavior.evidence.capture`。
- 必须且只能有一次 `behavior.trigger.invoke`。
- 末尾依次为唯一的 `behavior.scenario.deactivate` 和 `behavior.campaign.stop`。
- `behavior.node.variants`、registry、EvidenceSource 和 trigger availability 查询发生在正式执行前，不写入执行文件。
- 所有命令的 `campaignId` 和 `scenarioId` 必须与 `campaign.start` 一致。
- `scenarioId` 和 `campaignId` 使用稳定 identity，不加入 `SCOUT_RUN_ID`。

## Submit

正式执行只调用一次 `JarvisBehavior`：

```json
{
  "execute_file": "<bdd-id>/<version>/execute-file.json"
}
```

只提交执行文件路径，不拆分或逐条重复提交其中的 mutation 命令。以 Dynamic Tool 返回的执行摘要判断本次调用是否完成或明确失败。

## Prohibited Content

- 不写 BDD ID、目标版本、sequence、correlationId、request version、endpoint 或 timeout。
- 不写 WebSocket session、schema path、Jarvis CLI、宿主 executable、shell command 或 shell output。
- 不写 dynamic-tool 返回值、Campaign Journal、trace、evidence 或审查结论。
- 不加入第二个 Scenario 或第二次 trigger。

## Checklist

- 文件是单个合法 JSON object，路径符合 `<bdd-id>/<version>/execute-file.json`。
- `commands` 首尾和唯一命令数量正确。
- 参数与同版本 Pack 的 Behavioral identity、Hook mapping 和执行预期一致。
- 文件中只有 `commands` 及其 `command + payload`，没有 session、shell 或实际执行结果。

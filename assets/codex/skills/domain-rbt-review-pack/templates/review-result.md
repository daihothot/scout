---
scout:
  resource:
    requirement: required
    description: RBT Reviewer 交给 HTML 渲染工具的结构化审查结果模板。
artifact_type: RBTReviewResult
artifact_version: 1
---

# Review Result

此模板描述 `review-result.json` 的结构。所有描述性内容使用中文；BDD、版本、campaign、ID、字段名和 locator 保持原始技术值。

## JSON Contract

```json
{
  "bddId": "<bdd-id>",
  "targetVersion": "<version>",
  "campaignId": "<campaign-id>",
  "executorHistoryRef": "<executor-history-ref>",
  "scenarioId": "<scenario-id>",
  "summary": "<中文总体说明>",
  "timeline": [
    {
      "id": "JR-001",
      "title": "<中文预期标题>",
      "status": "match",
      "expected": "<预期值或结构>",
      "actual": "<实际值或结构>",
      "comparison": "<中文匹配规则和差异说明>",
      "note": "<中文补充说明>",
      "refs": {
        "journal": ["JR-001"],
        "signal": ["SR-001"],
        "runtime": ["<runtime locator>"],
        "code": ["E-CODE-001"]
      }
    }
  ]
}
```

## Fields

| field | required | description |
| --- | --- | --- |
| `bddId` | yes | 当前审查的 BDD identity。 |
| `targetVersion` | yes | Execution Pack 使用的目标版本。 |
| `campaignId` | yes | Reviewer 实际查询的 campaign identity。 |
| `executorHistoryRef` | yes | 同一 `execute-file.json` 最后一次 Executor 执行历史文件的稳定 ref，用于追溯执行侧；由 Runtime/执行顺序确认，不按修改时间猜测。 |
| `scenarioId` | no | 当前 scenario identity。 |
| `summary` | yes | 中文总体说明；不填写总状态。 |
| `timeline` | yes | 按 Executor 预期顺序排列的 `JR-*`/`SR-*` 点。 |
| `timeline[].id` | yes | 唯一的 `JR-*` 或 `SR-*`。 |
| `timeline[].status` | yes | `match`、`warning` 或 `not_match`。 |
| `timeline[].expected` | yes | Executor 预期的值或结构。 |
| `timeline[].actual` | yes | 实际取得的值或明确的缺失标记。 |
| `timeline[].comparison` | yes | 中文说明如何判定匹配、警告或不匹配。 |
| `timeline[].note` | no | 中文补充说明。 |
| `timeline[].refs` | no | 可定位到 Journal、Signal、Runtime 或 code evidence 的引用数组。 |

`expected`、`actual` 可以是字符串、数字、布尔值、数组或对象；渲染器按 JSON 结构展示，不要求 Agent 做字段映射。

## Ordering

`timeline` 的顺序就是报告的时间线顺序。它应与 `journal-expected.md` 和 `signal-expected.md` 中的预期顺序一致；工具不会按 ID 重新排序。

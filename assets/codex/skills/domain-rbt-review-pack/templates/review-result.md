---
scout:
  resource:
    requirement: required
    description: RBT Reviewer 交给 HTML 渲染工具的结构化审查结果模板。
artifact_type: RBTReviewResult
artifact_version: 4
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
      "title": "<中文 Journal 时间预期标题>",
      "status": "match",
      "expected": {
        "order": 1,
        "kind": "<kind>",
        "id": "<node-id>",
        "variantId": "none",
        "sourceId": "none",
        "captureId": "none",
        "signal_refs": ["SR-001"]
      },
      "actual": { "recordLocator": "<runtime locator>", "sequence": 1 },
      "comparison": "<中文时间关系比较说明>",
      "note": "<中文补充说明>",
      "refs": {
        "journal": ["JR-001"],
        "signal": ["SR-001"],
        "runtime": ["<runtime locator>"]
      }
    },
    {
      "id": "SR-001",
      "title": "<中文 Evidence 预期标题>",
      "status": "match",
      "expected": {
        "claim": "<中文业务预期>",
        "expected_presence": "present",
        "observation_scope": "<可由 campaign 查询证据核验的观察范围>",
        "fields": [
          { "field": "<原始字段路径>", "role": "assert", "expected_value": "<预期值>", "comparison": "<比较规则>" }
        ]
      },
      "actual": {
        "scope": "<从查询证据核验的实际观察范围或明确的缺口>",
        "records": ["<完整候选 record 或其稳定查询 locator>"],
        "field_comparisons": [
          { "field": "<原始字段路径>", "actual_value": "<实际值或明确缺失标记>", "result": "<比较事实>" }
        ]
      },
      "comparison": "<中文 Evidence 比较说明>",
      "refs": {
        "bdd": ["E-BDD-001#T-01"],
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
| `targetVersion` | yes | 正式交付声明的目标版本。 |
| `campaignId` | yes | Reviewer 实际查询的 campaign identity。 |
| `executorHistoryRef` | yes | 同一 `execute-file.json` 最后一次 Executor 执行历史文件的稳定 ref，用于追溯执行侧；由 Runtime/执行顺序确认，不按修改时间猜测。 |
| `scenarioId` | no | 当前 scenario identity。 |
| `summary` | yes | 中文总体说明；不填写总状态。 |
| `timeline` | yes | 全部 `JR-*` 与 `SR-*` 比较点；每个 ID 只出现一次。 |
| `timeline[].id` | yes | 唯一的 `JR-*` 或 `SR-*`。 |
| `timeline[].status` | yes | `match`、`warning` 或 `not_match`。 |
| `timeline[].expected` | yes | Executor 预期的值或结构。 |
| `timeline[].actual` | yes | 实际取得的值或明确的缺失标记。 |
| `timeline[].comparison` | yes | 中文说明如何判定匹配、警告或不匹配。 |
| `timeline[].note` | no | 中文补充说明。 |
| `timeline[].refs` | no | Journal、Signal、Runtime 定位，以及从声明沿用的 BDD/code 引用；不要求展开来源。 |

`expected`、`actual` 可以是字符串、数字、布尔值、数组或对象；渲染器按 JSON 结构展示，不要求 Agent 做字段映射。

## Ordering

`timeline` 的顺序就是报告的时间线顺序。Reviewer 按 `journal-expected.md` 的表格行序写入每个 JR，并在其后写入被引用且尚未出现的 SR；没有 JR 的 SR 再按 `signal-expected.md` 声明顺序追加。共享的 SR 只展示一次，工具不会按 ID 重新排序。`order: none` 的展示位置不代表顺序断言。

JR 点的 `expected` 保存表格行的 `order`、关键 identity 和 `signal_refs`；`actual` 保存关联的 record locator、实际 `sequence` 及参与顺序比较的记录。SR 点保存完整观察范围、presence 与 Fields 的逐字段比较，不能因实际值错误而丢弃候选记录。示例中的 `none` 表示该列不限定，无需读取 Journal 编写模板。

实际业务值与观察范围依据只来自 campaign 历史查询 metadata/evidence；query refs、缺失或歧义必须保留。Review Result 作为上层结果可以保留 JR/SR 已有的 BDD/code refs，不要求 Reviewer 打开其正文或核验整个 Pack；下层 artifacts 不反向引用 Review Result。

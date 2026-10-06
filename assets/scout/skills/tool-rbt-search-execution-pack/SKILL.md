---
assetKind: scout.skill
name: tool-rbt-search-execution-pack
description: 已确认 BDD 和 SDK 版本，需要搜索可复用的历史 Execute Pack 时使用。
id: tool-rbt-search-execution-pack
version: 0.1.0
type: tool
family: [tool, rbt, artifact]
tags: [rbt, execution, pack, dynamic-tool]
devices: [any]
dependencies:
  skills:
    required: [domain-rbt, tool-scout-resolve-artifact-reference]
summary: 定义 SearchExecutionPack 的查询输入与 Execute Pack 引用结果。
---

# Search Execution Pack

使用 `SearchExecutionPack` 搜索相同 BDD、SDK 版本下执行与审查均成功的历史 Execute Pack。公共术语与 `ScoutArtifactReference` 见 `domain-rbt`。

## Input

```json
{
  "bdd_id": "<canonical-bdd-id>",
  "target_version": "<sdk-version>"
}
```

沿用当前任务已经确认的 BDD 和 SDK 版本。

## Results

命中时返回：

```json
{
  "status": "found",
  "execute-pack-ref": {
    "workflowId": "workflow-009",
    "agentId": "executor",
    "internalSymbols": ["pack"]
  }
}
```

该 Pack 已通过格式检查，可以作为本次引用的 Pack；获得引用不等于取得读取权限。按 `tool-scout-resolve-artifact-reference` 解析引用并申请当前 Turn 的只读访问。

`not_found` 表示没有可用 Pack。`failed` 表示查询或工具执行失败，不等同于未命中；保留原始错误。

本工具提供 Pack 引用，不执行 Pack，也不替代 Executor 的执行与交付流程。

---
assetKind: scout.skill
name: tool-rbt-select-execution-source
description: Executor 已取得任务确认的 platform，需要绑定当前 Workflow 的执行配置时使用。
id: tool-rbt-select-execution-source
version: 0.1.0
type: tool
family: [tool, rbt, execution]
tags: [rbt, execution, platform, dynamic-tool]
devices: [any]
dependencies:
  skills:
    required: [domain-rbt]
summary: 定义 SelectExecutionSource 的平台输入和选择结果。
---

# Select Execution Source

Executor 在活动 Workflow 中，用 Coordinator 已确认的任务 `platform` 调用 `SelectExecutionSource`，然后继续 Runtime 查询、Pack 准备与执行。平台标识见 `domain-rbt` 的 Platform。

## Input

```json
{
  "platform": "unity_editor"
}
```

只传任务中的 platform；不传 transport、appId 或其它物理配置。不从 Pack 或目录名称选择另一平台。

## Results

```json
{
  "status": "selected",
  "platform": "unity_editor"
}
```

`selected` 表示当前 Workflow 已绑定该平台的执行配置，不表示应用已启动或执行成功。再次提交同一平台仍返回 `selected`；当前 Workflow 不切换平台，Reviewer 使用已有绑定。

配置缺失、平台冲突或工具执行失败时，保留实际错误并停止依赖工作，不尝试其它平台。

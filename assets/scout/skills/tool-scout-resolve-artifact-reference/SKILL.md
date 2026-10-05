---
assetKind: scout.skill
name: tool-scout-resolve-artifact-reference
description: 将 ScoutArtifactReference 定位到当前物理路径，并在读取外部 Artifact 前申请临时只读权限。
id: tool-scout-resolve-artifact-reference
version: 0.1.0
type: tool
family: [tool, scout, dynamic, general, artifact]
tags: [scout, artifact, reference, read]
devices: [any]
summary: 定义 Artifact 引用解析工具与外部 Artifact 的临时只读申请方法。
---

# Resolve Artifact Reference

## Input

```json
{
  "reference": {
    "workflowId": "<Artifact 所属 Workflow>",
    "agentId": "<Artifact 所属 Agent>",
    "internalSymbols": ["<目录分段>", "<文件名>"]
  }
}
```

将已获得的引用原样传入 `ResolveArtifactReference`。目录引用可用于定位其中明确已知的文件，不扫描其它目录或猜测 Workflow 物理名称。

## Result

- `{"status":"resolved","path":"<物理绝对路径>"}`：使用本次返回的路径。
- `{"status":"unavailable","reason":"<原因>"}`：保留缺口，不猜测替代路径。

解析只定位产物，不授予访问权限。

## Read Access

本 Workflow 中自身 Artifact 使用当前 Workflow Context 的读写范围。本 Workflow 其它 Agent 的 Artifact，以及其它 Workflow 的 Artifact，读取前调用内置 `request_permissions`，只申请返回路径的文件系统只读权限，范围为当前 Turn；参数遵循内置工具当前 schema。

批准后读取；未批准则保留访问缺口。新 Turn 仍需申请该 Turn 的权限。只申请实际需要的目录或文件，不申请写入、网络或其它范围；不需要填写内部登记 ID。

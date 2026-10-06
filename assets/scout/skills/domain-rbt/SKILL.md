---
assetKind: scout.skill
name: domain-rbt
description: RBT 各角色解释领域公共术语、Artifact 定位与稳定引用时使用，由角色 Domain Skill 作为 required 依赖引入。
id: domain-rbt
version: 0.1.0
type: domain
domain: rbt
family: [rbt]
tags: [scout, rbt, contract, artifact, reference]
devices: [any]
summary: 定义 RBT 领域公共术语、Artifact 路径与稳定引用格式。
---

# Domain RBT

RBT（Runtime Behavioral Test，运行时行为测试）用于验证目标 SDK 的运行时行为是否符合 BDD 定义的业务承诺。以 BDD 和对应版本源码形成执行计划与预期，通过受控执行采集运行证据，再比较预期与实际证据形成审查结论。

## Agent Identity

| Agent Identity | 说明 |
| --- | --- |
| `coordinator` | 编排与协调 |
| `executor` | 执行 BDD 验证 |
| `reviewer` | 审查执行证据与结果 |

以上是当前 RBT Workflow 中的 Agent Identity。

## Phase

| Phase | 说明 |
| --- | --- |
| `Synthesis` | Coordinator 协调任务与阶段结果 |
| `execute` | 执行 BDD 验证并产生运行证据 |
| `review` | 比较预期与运行证据，形成审查结论 |

`Synthesis` 是协调阶段，`execute` 和 `review` 是 Workflow 的业务推进阶段。

## Guru Ecosystem

| 术语 | 说明 |
| --- | --- |
| Guru Knowledge | Guru 的结构化知识库，记录产品、业务领域、能力及行为规范 |
| Guru SDK | 基于 Unity 引擎的游戏开发 SDK，提供账号登录、数据分析、商业化、增长等公共业务能力与通用运行基础设施，是 RBT 的被测对象 |

Knowledge 描述业务知识与行为约定，Guru SDK 提供对应的业务实现。

## Verification Target

| 术语 | 说明 |
| --- | --- |
| BDD | Guru Knowledge 中业务行为规范的统一标识，格式为 `gurusdk.behavior.<name>`；名称体现业务对象、操作与预期 |
| Version | Guru SDK 的基线 Tag 编号，标识被验证的 SDK 源码基线 |

例如，`gurusdk.behavior.firebase-remote-config-getter-default-fallback` 标识 Firebase Remote Config getter 的默认值回退行为。

## Platform

| 平台标识 | 说明 |
| --- | --- |
| `unity_editor` | Unity Editor 执行环境 |
| `android` | Android 应用执行环境 |
| `ios` | iOS 应用执行环境，目前 RBT 连接尚未实现 |

以上是当前 RBT 的平台标识。Platform 描述执行环境，与 transport、设备型号和平台版本分别表示不同的信息。

## RBT Workflow

RBT Workflow 是围绕一个确定的 BDD 与 Guru SDK 基线版本展开的一次验证过程，包含执行、审查，以及关联的 Pack 和运行证据。

## Pack

| 术语 | 说明 |
| --- | --- |
| Execute Pack | 保存执行依据与预期 |
| Review Pack | 保存证据比较事实与审查结论 |

Pack 是围绕同一个 BDD 与目标 SDK 版本组织的一组关联 Artifact。

## Artifact Addressing

| 术语 | 说明 |
| --- | --- |
| `artifact-root` | 当前 Workflow 中本 Agent 自己的 Artifact 物理目录，用于读写自身产物 |
| `artifact-root-ref` | 某个 Agent 的 Artifact 根目录引用，`internalSymbols` 为 `[]` |
| `execute-pack-ref` | Executor 的 Execute Pack 引用，`internalSymbols` 为 `["pack"]` |

Artifact 引用由 `ScoutArtifactReference` 结构表示：

```json
{
  "workflowId": "workflow-001",
  "agentId": "executor",
  "internalSymbols": ["pack"]
}
```

| 字段 | 含义 |
| --- | --- |
| `workflowId` | Artifact 所属 Workflow 的稳定身份 |
| `agentId` | Artifact 所属 Agent Identity |
| `internalSymbols` | Artifact 内部的产物标识，例如 Pack 或 History |

| `internalSymbols` | 定位对象 |
| --- | --- |
| `[]` | Agent 的 Artifact 根目录 |
| `["pack"]` | Executor 的 Execute Pack 或 Reviewer 的 Review Pack，由 `agentId` 区分 |
| `["history"]` | Executor 的执行历史产物 |

物理位置由 `ResolveArtifactReference` 解析，访问权限由授权机制提供。工具说明见 `tool-scout-resolve-artifact-reference`。

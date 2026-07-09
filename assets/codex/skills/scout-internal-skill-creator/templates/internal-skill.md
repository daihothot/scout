---
assetKind: scout.skill
name: <skill-name>
description: <一句话说明它做什么，以及什么任务会触发使用>
id: skills.<domain>.<stable-id>
version: 0.1.0
phase: [research]
tags: [scout, evidence]
devices: [any]
dependencies:
  skills:
    required: [<required-skill>]
  shellTools:
    required: [<required-shell-tool>]
    optional: [<optional-shell-tool>]
summary: <候选展示用短描述>
---

# <Title>

当 <触发场景> 时使用本技能。

本技能的目标是 <用一句话说明可复用方法论目标>。

## Skill Type

- type: <workflow | tool | boundary | meta>
- structure_level: <full | compact>
- note: <如果是 meta Skill 或轻量 Tool Skill，说明哪些业务 Skill 结构仍必须遵循。>

## Core Use

使用本技能处理：

- <职责 1>
- <职责 2>
- <职责 3>

不使用本技能处理：

- <非目标 1>
- <非目标 2>
- <非目标 3>

## <Domain / Tool / Knowledge Model>

<说明本 Skill 依赖的领域、工具、知识库、codebase、artifact 或状态模型。>

模型规则：

- <动态能力、仓库、工具或可见性必须以当前 mount 查询或当前工具输出为准。>
- <不得把非当前输出、示例项、旧文档或历史记忆写成当前事实。>
- <需要上游确认的信息必须记录为需人工确认项。>

## Inputs

### I-001: <Input Name>
---

描述：

- <输入内容、来源或可推断条件。>

注意事项：

- <缺失、不唯一、冲突或不可验证时如何记录为需人工确认项或阻塞项。>
- <该输入不能被哪些内容替代。>

### I-002: <Input Name>
---

描述：

- <输入内容、来源或可推断条件。>

注意事项：

- <缺失、不唯一、冲突或不可验证时如何记录为需人工确认项或阻塞项。>
- <该输入不能被哪些内容替代。>

## <Workflow Overview>

本节只列阶段顺序；具体命令、模板、注意事项和证据要求见各 Phase。

- Phase 1：<阶段目标>
- Phase 2：<阶段目标>
- Phase 3：<阶段目标>

## <Output Layout>

产物位置由上游、当前 role layout 或当前 task artifact layout 决定。

产物要求：

- <artifact ref、文件名模式或模板引用。>
- <必须包含的字段、证据编号或 provenance。>
- <完成、需人工确认项、阻塞项或证据不足时的输出差异。>
- <弱 schema 状态字段，例如 status、blocking_items、failed_commands、retry_log 和 limitations。>

状态字段：

- workflow / summary / manual / gate artifact：`status: draft | ready | blocked`。
- workflow / summary / manual / gate artifact：`completion_state: complete | partial | blocked`。
- detail / evidence artifact：至少定义 `status`，并说明是否需要 `completion_state`。

模板引用：

```text
templates/<artifact-template>.md
```

模板 / Reference 索引：

- <如果 templates 下超过一个文件，必须提供 templates/template-index.md，说明模板用途和读取顺序。>
- <如果 references 下存在文件，必须提供 references/reference-index.md，说明 reference 用途和读取顺序。>
- <index 文件只做导航，不承载业务事实、证据事实、运行状态或当前 task 判断。>

### Artifact Relationship Rules

- <本章节名固定为 Artifact Relationship Rules；不要改成本地化标题。>
- 摘要产物：<说明是否存在摘要聚合产物；它是摘要索引、完整块集合还是下游手册。>
- 明细产物：<说明是否存在单条明细产物；它是否独立成文件、note 或外部 artifact。>
- Registry / index：<说明 registry 或 index 只做导航、索引或 refs，还是允许承载其它内容。>
- Claim owner：<说明 claim 由哪个 artifact 定义，避免多个文件重复定义同一 claim。>
- 下游引用规则：<说明下游只能引用 evidence id、artifact ref、detail ref、locator 还是其它字段。>
- Ref 字段策略：<说明 artifact_ref、detail_ref 或类似字段是 required、optional 还是不使用。>

注意事项：

- Skill 不随意发明新的 canonical artifact 目录。
- 模板只定义 artifact 形态、字段约束、证据编号和 provenance 要求。

## Phase 1: <Phase Name>
---

本阶段 <说明阶段目的和作用>。

使用命令：

```bash
<read-only-or-authorized-command>
```

使用模板：

```text
templates/<artifact-template>.md
```

注意事项：

- <该阶段必须记录的来源、命令、locator、artifact ref 或 evidence ref。>
- <工具输出属于 Activity State，不能直接当作业务结论。>
- <缺少能力、输入或证据时如何记录为需人工确认项或阻塞项。>

Exit：

- <满足什么条件后可进入下一 Phase。>

Blocked：

- <哪些情况必须停止并记录阻塞项。>

Partial：

- <哪些缺口允许部分完成并交接，必须记录在哪里。>

## Phase 2: <Phase Name>
---

本阶段 <说明阶段目的和作用>。

只读命令：

```bash
<read-only-command>
```

副作用命令：

```bash
<side-effect-command>
```

注意事项：

- 副作用命令默认不执行；必须有明确任务要求或上游明确授权。
- <该阶段必须记录的 provenance、limitation 或 artifact ref。>
- <该阶段不能替代的后续证据或人工确认。>

Exit：

- <满足什么条件后可进入下一 Phase 或完成输出。>

Blocked：

- <哪些情况必须停止并记录阻塞项。>

Partial：

- <哪些缺口允许部分完成并交接，必须记录在哪里。>

## Workflow Exit Rules (Enforcement)

- XR-001：<跨阶段前置条件和禁止跳过规则。>
- XR-002：<需人工确认项、阻塞项或部分完成状态如何影响整体交付。>
- XR-003：<最终输出何时可标记 complete，以及何时不得宣称完成。>

## Evidence Rules (Enforcement)

- ER-001：<证据成立条件 1。>
- ER-002：<证据成立条件 2。>
- ER-003：<Activity State、工具输出、artifact、evidence ref 或 runtime observation 的边界。>

## Failure Rules (Enforcement)

- FR-001：<命令失败、空输出、权限失败、解析失败或模板字段缺失时必须记录 failed_commands、影响范围和 limitation。>
- FR-002：<证据不闭环、locator 不可定位或 artifact 写入失败时不得当作成功。>
- FR-003：<失败事实必须写入产物、交付说明或上游可消费的阻塞项。>

## Blocking Rules (Enforcement)

- BR-001：<缺少 required skill、tool、MCP server、plugin、mount 路径或写入权限时必须停止。>
- BR-002：<输入不可唯一定位、目标版本缺失、证据链无法继续或模板不存在时必须记录阻塞项。>
- BR-003：<阻塞时不得继续进入依赖该条件的后续 Phase。>

## Retry Rules (Enforcement)

- RR-001：<只允许对只读、瞬时、可恢复失败进行有限重试，并记录 retry_log。>
- RR-002：<有副作用命令重试前必须有明确任务要求或上游授权。>
- RR-003：<重试不得改变业务输入、repo、版本、范围或证据语义来制造成功。>

## Prohibited Rules (Enforcement)

- PR-001：禁止 <禁止行为 1。>
- PR-002：禁止 <禁止行为 2。>
- PR-003：禁止 <禁止行为 3。>

## Example

输入：

```text
<上游输入摘要>
```

流程：

1. <关键步骤>
2. <关键步骤>
3. <关键步骤>

输出：

- <artifact ref 或结果形态>
- <evidence refs、需人工确认项、阻塞项或限制说明>

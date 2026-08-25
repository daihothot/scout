---
scout:
  resource:
    requirement: optional
    description: 创建 layout 为 workflow 的 Skill 时使用的正文结构模板。
---

# Workflow Layout Template

## Selection

当 contract 包含必须按顺序执行的阶段、状态转换或完成门禁时，选择 `layout: workflow` 并使用本模板。

步骤较多不是选择 workflow 的充分条件；只有跳过或乱序会破坏 contract 时，才使用编号 Phase。

## Document Structure

以下名称定义模板中对应占位符的实际内容：

| 名称 | 实际内容 |
| --- | --- |
| `skill-title` | Skill 标题。 |
| `purpose-and-usage` | 使用场景和触发条件。 |
| `ownership-boundary` | 当前 Skill 拥有和不拥有的责任。 |
| `skill-type` | 选定的实际 type。 |
| `responsibility-note` | Skill Type 中的简短责任说明。 |
| `core-use-item` | 当前 Skill 处理的一项工作。 |
| `core-exclusion-item` | 当前 Skill 不处理的一项工作。 |
| `contract-section-name` | 与当前 contract 语义一致的实际章节名。 |
| `type-required-contract-content` | type template 要求的模型、contract 或规则内容。 |
| `conditional-section-name` | 条件内容适用时使用的实际章节名。 |
| `applicable-conditional-contract-content` | 当前条件已经成立的 contract 内容。 |
| `input-name` | 一项正式输入的实际名称。 |
| `input-description` | 输入内容、来源和可推断边界。 |
| `input-boundary` | 输入缺失、冲突或不可验证时的处理规则。 |
| `workflow-definition` | 理解全部 Phase 前必须声明的共享术语；没有时删除。 |
| `phase-goal` | 一个 Phase 的目标摘要。 |
| `result-section-name` | 正式输出或结果 contract 的实际章节名。 |
| `result-and-limitation-contract` | 输出结构、所有权、限制和下游关系。 |
| `phase-name` | Phase 的实际名称。 |
| `phase-purpose` | 当前 Phase 的目的。 |
| `phase-content` | 当前 Phase 拥有的步骤、判断或局部小节。 |
| `condition-for-entering-the-next-phase` | 当前 Phase 可以退出并进入下一阶段的实际条件。 |
| `phase-blocking-condition` | 当前 Phase 必须停止的实际条件。 |
| `allowed-partial-result-and-record-location` | 当前 Phase 允许保留的部分结果及其记录位置；不存在时使用 `none`。 |
| `cross-phase-or-final-exit-rule` | 跨阶段顺序或最终完成门禁。 |
| `evidence-admission-and-sufficiency-rule` | 当前 Skill 已定义 evidence 时的准入或充分性门禁。 |
| `failure-fact-and-result-rule` | 失败事实、记录方式及不能形成的结果。 |
| `condition-that-blocks-dependent-work` | 必须阻塞当前或后续依赖工作的条件。 |
| `retry-precondition-limit-and-stop-rule` | 重试前提、限制和停止条件。 |
| `prohibited-behavior` | 当前 contract 无条件禁止的行为。 |
| `example-input` | 能澄清非显然决策的实际示例输入。 |
| `example-process` | 示例中应用当前 contract 的实际过程。 |
| `example-output` | 示例允许形成的实际输出。 |
| `completion-check` | 根据当前 contract 可以直接判断的完成检查。 |

目标 `SKILL.md` 按以下顺序组织：

````markdown
# <skill-title>

<purpose-and-usage>

<ownership-boundary>

## Skill Type

- type: <skill-type>
- layout: workflow
- note: <responsibility-note>

## Core Use

使用本技能处理：

- <core-use-item>

不使用本技能处理：

- <core-exclusion-item>

## <contract-section-name>

<type-required-contract-content>

## Inputs

### I-001: <input-name>
---

描述：

- <input-description>

注意事项：

- <input-boundary>

## <conditional-section-name>

<applicable-conditional-contract-content>

## Workflow Overview

<workflow-definition>

Phase 说明：

- Phase 1：<phase-goal>
- Phase 2：<phase-goal>

## <result-section-name>

<result-and-limitation-contract>

## Phase 1: <phase-name>
---

<phase-purpose>

<phase-content>

Exit：

- <condition-for-entering-the-next-phase>

Blocked：

- <phase-blocking-condition>

Partial：

- <allowed-partial-result-and-record-location>

## Workflow Exit Rules (Enforcement)

- XR-001：<cross-phase-or-final-exit-rule>

## Evidence Rules (Enforcement)

- ER-001：<evidence-admission-and-sufficiency-rule>

## Failure Rules (Enforcement)

- FR-001：<failure-fact-and-result-rule>

## Blocking Rules (Enforcement)

- BR-001：<condition-that-blocks-dependent-work>

## Retry Rules (Enforcement)

- RR-001：<retry-precondition-limit-and-stop-rule>

## Prohibited Rules (Enforcement)

- PR-001：禁止 <prohibited-behavior>。

## Example

输入：

```text
<example-input>
```

流程：

- <example-process>

输出：

- <example-output>

## Checklist

- <completion-check>
````

`Core Use` 必须保留。只有存在容易误路由的相邻能力时，才保留其中的“`不使用本技能处理`”及 `core-exclusion-item`；否则删除这个子段。conditional、`Inputs`、result 和 `Example` 只在存在真实内容时保留，但保留时必须处于上面规定的位置。一个 Skill 可以拥有多个按语义命名的 contract 或 conditional 章节；不能使用 `Required Content`、`Conditional Content` 或 `Ownership Rules` 作为目标章节名。

type template 的 Required Content 按语义写入 Core Use、contract、`Inputs`、result 或 Phase。理解全部阶段所需的模型和术语必须在 Workflow Overview 之前声明；正式输出或结果结构必须在第一个 Phase 之前声明；只有执行过程中才产生的事实写入对应 Phase。

Workflow Overview 先声明理解全部 Phase 所需的共享术语，再使用 `Phase 说明` 列出阶段顺序和目标。没有共享术语时直接从 `Phase 说明` 开始；不在 Overview 中复制 Phase 的具体步骤。

为每个真实阶段复制 Phase 结构。`<phase-content>` 可以包含当前 Phase 的步骤、判断或语义小节，但不能拥有其它 Phase 的工作。每个 Phase 都必须包含 Exit、Blocked 和 Partial；不存在 Partial 时使用字面值 `none`，不要发明部分完成路径。

门禁小节按以下语义使用：

- `Workflow Exit Rules (Enforcement)` 定义跨阶段顺序、进入下一阶段和最终退出条件。workflow 必须保留本节。
- `Evidence Rules (Enforcement)` 定义 evidence 的来源、完整性、可验证性、准入条件和不可替代条件。
- `Failure Rules (Enforcement)` 定义失败事实如何记录，以及失败时不能形成哪些结果或结论。
- `Blocking Rules (Enforcement)` 定义必须停止当前阶段或后续依赖工作的条件。
- `Retry Rules (Enforcement)` 定义允许重试的前提、次数、授权和停止条件。
- `Prohibited Rules (Enforcement)` 定义任何阶段都不得执行的行为。

除 `Workflow Exit Rules (Enforcement)` 外，只保留存在真实门禁的 Enforcement 小节。保留的小节必须按照上述顺序排列，不创建其它自定义门禁类别。

`Example` 只在能够澄清非显然输入、分支或输出时保留，不得把一次运行事实或特定任务结果写成通用示例。`Checklist` 必须是最终章节。

## Formatting Rules

- Scout 正式术语、字面值和单一路径使用反引号；可执行命令、多行目录结构、schema 和命名形式使用具有语言标记的 fenced code block。
- 每个占位符必须在模板中先定义再使用；完成态正文不得保留占位符。
- Workflow Overview 只保留共享定义、阶段顺序和目标，不重复阶段内部规则。
- 每条 Enforcement rule 只表达一个可判断的条件和结果。
- 只在 Phase 标题和 `I-001`、`I-002` 等 Inputs 标题下使用分隔线。
- 删除所有填写说明、未替换占位符、空章节和不适用的可选章节。

## Checklist

- `layout` 是 `workflow`，`type` 来自独立的 type template。
- type template 要求的内容已按 Template Application 映射到实际语义章节，没有复制 type template 标题。
- Core Use、model/contract、Inputs、Workflow Overview、result、Phase 和 Enforcement 按规定顺序排列。
- Workflow Overview、各 Phase 和 Workflow Exit Rules 的顺序一致。
- 每个 Phase 的 Exit、Blocked 和 Partial 可以被明确判断。
- Enforcement 小节使用固定类别和顺序，不存在宽泛或自定义 rule category。
- 正式输出、状态事实、artifact、ref 和 handoff 的所有者不冲突。
- 有副作用的操作具有明确授权和重试边界。
- 不适用的小节已经删除，完成态正文不残留填写说明或占位符，Checklist 是最终章节。

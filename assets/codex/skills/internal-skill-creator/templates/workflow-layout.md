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
| `contract-section-name` | 与当前 contract 语义一致的实际章节名。 |
| `type-required-contract-content` | type template 要求的模型、contract 或规则内容。 |
| `conditional-section-name` | 条件内容适用时使用的实际章节名。 |
| `applicable-conditional-contract-content` | 当前条件已经成立的 contract 内容。 |
| `input-name` | 一项正式输入的实际名称。 |
| `required-input-field` | 必需输入字段、字段语义和权威来源。 |
| `optional-input-field` | 可选输入字段及其缺失语义；没有时使用 `none`。 |
| `missing-input-handling` | 一个输入字段缺失、空值、不可读或不唯一时的处理。 |
| `input-confirmation-condition` | 输入字段、来源和当前事实必须满足的整体确认条件。 |
| `workflow-definition` | 理解全部 Phase 前必须声明的共享术语；没有时删除。 |
| `phase-goal` | 一个 Phase 的目标摘要。 |
| `result-section-name` | 正式输出或结果 contract 的实际章节名。 |
| `result-and-limitation-contract` | 输出结构、所有权、限制和下游关系。 |
| `phase-name` | Phase 的实际名称。 |
| `phase-knowledge` | 当前 Phase 主干共享的概念、术语、事实来源、Tool/Skill 导航和不变量。 |
| `phase-main-flow` | 当前 Phase 的主要动作、关键业务分支和最终去向组成的 Mermaid flowchart 内容；没有内部流程时删除整个 Flow。 |
| `phase-subflow-name` | 主干中一个需要局部展开的复杂节点名称。 |
| `phase-subflow-knowledge` | 只服务当前 Subflow 的概念、术语、事实来源和 Tool/Skill 导航。 |
| `phase-subflow` | 只解释对应复杂节点内部动作和分支的 Mermaid flowchart 内容。 |
| `phase-subflow-constraint` | 当前 Subflow 必须维持的一个局部不变量或判断约束。 |
| `phase-subflow-blocking-condition` | 当前 Subflow 必须停止并返回 Main Flow 的一个原子条件。 |
| `phase-subflow-partial-result` | 当前 Subflow 允许保留的一种部分结果及其所有者或记录位置；不存在时使用 `none`。 |
| `phase-subflow-return` | 当前 Subflow 返回 Main Flow 的一个结果名称及其成立条件。 |
| `condition-for-entering-the-next-phase` | 当前 Phase 可以退出并进入下一阶段的实际条件。 |
| `phase-blocking-condition` | 当前 Phase 必须停止的一个原子条件。 |
| `allowed-partial-result-and-record-location` | 当前 Phase 允许保留的一种部分结果及其所有者或记录位置；不存在时使用 `none`。 |
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

## <contract-section-name>

<type-required-contract-content>

## Inputs

### I-001: <input-name>
---

Required：

- <required-input-field>

Optional：

- <optional-input-field>

Missing：

- <missing-input-handling>

Confirmation：

- <input-confirmation-condition>

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

Main Flow：

Knowledge：

- <phase-knowledge>

Flow：

```mermaid
flowchart TD
  <phase-main-flow>
```

Blocked：

- <phase-blocking-condition>

Partial：

- <allowed-partial-result-and-record-location>

Exit：

- <condition-for-entering-the-next-phase>

Subflow — <phase-subflow-name>：

Knowledge：

- <phase-subflow-knowledge>

Flow：

```mermaid
flowchart TD
  <phase-subflow>
```

Constraints：

- <phase-subflow-constraint>

Blocked：

- <phase-subflow-blocking-condition>

Partial：

- <phase-subflow-partial-result>

Returns To Main Flow：

- <phase-subflow-return>

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

`Core Use` 必须保留，并且只列当前 Skill 实际处理的工作。不要添加“`不使用本技能处理`”或其它反向用途清单。conditional、`Inputs`、result 和 `Example` 只在存在真实内容时保留，但保留时必须处于上面规定的位置。一个 Skill 可以拥有多个按语义命名的 contract 或 conditional 章节；不能使用 `Required Content`、`Conditional Content` 或 `Ownership Rules` 作为目标章节名。

保留 `Inputs` 时，每个 Input 必须完整包含 `Required`、`Optional`、`Missing` 和 `Confirmation`。没有可选字段时在 `Optional` 中写 `none`，不能删除该项。`Missing` 必须逐字段定义处理；`Confirmation` 必须给出可以直接判断的整体通过条件。

type template 的 Required Content 按语义写入 Core Use、contract、`Inputs`、result 或 Phase。只有全部 Phase 在进入任何阶段前共同依赖的模型和术语，才在 Workflow Overview 之前声明；正式输出或结果结构必须在第一个 Phase 之前声明。只在某一个 Phase 中产生、定义或首次使用的概念、术语、规范、Tool 导航、判断和事实，必须写入该 Phase，并在本 Phase 首次使用前说明，不能提前堆放在全局 contract 或 Workflow Overview 中。

Workflow Overview 先声明理解全部 Phase 所需的共享术语，再使用 `Phase 说明` 列出阶段顺序和目标。没有共享术语时直接从 `Phase 说明` 开始；不在 Overview 中复制 Phase 的具体步骤。

为每个真实阶段复制 Phase 结构。Main Flow 固定使用 `Knowledge`、`Flow`、`Blocked`、`Partial`、`Exit` 的顺序；每个 Subflow 固定使用 `Knowledge`、`Flow`、`Constraints`、`Blocked`、`Partial`、`Returns To Main Flow` 的顺序。

- Main Flow 的 `Knowledge` 只解释整个 Phase 主干共享的概念、术语、事实来源、Tool/Skill 导航和不变量。只服务某个 Subflow 的内容必须就近放入该 Subflow，不能提前堆在主干。
- 当前 Phase 存在两个以上有序动作、条件判断或分支时，必须保留 `Flow` 并使用 Mermaid `flowchart` 表达。流程顺序和分支只在图中表达，不能再用相邻编号列表或段落复制一遍。没有内部流程时删除整个 `Flow`。
- `Main Flow` 只展示主要动作、关键业务分支，以及进入 `Exit` 或 `Blocked` 的最终去向。命令级成功、失败、未知状态和字段级门禁不逐项展开。
- 主干中的一个节点确实包含影响执行理解的局部顺序或业务分支时，可以增加一个独立 `Subflow`。每个 Subflow 是就近闭合的小上下文，只展开一个主干节点，不重复主干前后步骤；简单 Phase 删除全部 Subflow。
- Subflow 的 `Knowledge` 只解释本子流程需要的概念、来源和 Tool/Skill 导航；`Constraints` 只列本子流程的局部不变量、判断规则和禁止事项。
- Subflow 的 `Returns To Main Flow` 必须列出所有返回结果及其成立条件；结果名称必须与 Main Flow 对应节点后的分支标签完全一致。Main Flow 与 Subflow 不绘制跨图连线，也不把 Subflow 当作独立 Phase。
- Subflow 的 `Blocked` 只表示当前子流程无法继续，不直接决定整个 Phase 的状态；`Returns To Main Flow` 必须把每类局部阻塞映射为主干可以消费的结果，由 Main Flow 决定 Phase 进入 `Blocked`、其它处理或后续动作。
- Main Flow 和 Subflow 的 `Blocked` 每条只表达一个原子阻塞条件。Subflow 已拥有的阻塞细节不得复制到 Main Flow。
- Main Flow 和 Subflow 的 `Partial` 每条只表达一种允许保留的部分结果及其所有者或记录位置。Subflow 已拥有的部分结果不得复制到 Main Flow；不存在时使用字面值 `none`。
- Main Flow 的 `Exit` 每条只表达一个可直接判断的阶段通过条件。默认全部 Exit 条件都成立时 Phase 才通过；Subflow 不使用 Exit。

当前 Phase 产生、定义或首次使用的内容必须就地说明，不能要求读者跳回前置大段寻找上下文，也不能拥有其它 Phase 的工作。

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
- Phase 内部存在流程时使用一张 Main Flow 和必要的 Subflow 表达，不再用正文或编号列表复制流程。每个 Subflow 的知识、约束和结果必须紧邻该图。
- 每条 Enforcement rule 只表达一个可判断的条件和结果。
- 只在 Phase 标题和 `I-001`、`I-002` 等 Inputs 标题下使用分隔线。
- 删除所有填写说明、未替换占位符、空章节和不适用的可选章节。

## Checklist

- `layout` 是 `workflow`，`type` 来自独立的 type template。
- type template 要求的内容已按 Template Application 映射到实际语义章节，没有复制 type template 标题。
- Core Use、model/contract、Inputs、Workflow Overview、result、Phase 和 Enforcement 按规定顺序排列。
- 每个 Input 都完整声明 `Required`、`Optional`、`Missing` 和 `Confirmation`，且 `Confirmation` 可以直接判断。
- Workflow Overview、各 Phase 和 Workflow Exit Rules 的顺序一致。
- 只服务单一 Phase 的概念、术语、规范、Tool 导航、判断和事实均在该 Phase 首次使用前就地说明，没有提前堆放在全局章节。
- 每个 Phase 的 Main Flow 按 `Knowledge`、`Flow`、`Blocked`、`Partial`、`Exit` 组织。
- 每个 Subflow 按 `Knowledge`、`Flow`、`Constraints`、`Blocked`、`Partial`、`Returns To Main Flow` 组织。
- 存在内部流程的 Phase 使用一张 Main Flow 和必要的 Subflow，且没有重复的正文流程。
- Main Flow 只保留主要动作、关键业务分支和最终去向；每个 Subflow 只展开一个同名主干节点，并就近声明局部知识、约束和结果。
- Subflow 的每个返回结果都与 Main Flow 分支标签同名，成立条件明确。
- Subflow 的每个局部 Blocked 都已映射到一个 `Returns To Main Flow` 结果，Phase 状态只由 Main Flow 决定。
- 每条 Exit 是一个可直接判断的通过条件，每条 Blocked 是一个原子阻塞条件，每条 Partial 是一种部分结果及其所有者或记录位置。
- Enforcement 小节使用固定类别和顺序，不存在宽泛或自定义 rule category。
- 正式输出、状态事实、artifact、ref 和 handoff 的所有者不冲突。
- 有副作用的操作具有明确授权和重试边界。
- 不适用的小节已经删除，完成态正文不残留填写说明或占位符，Checklist 是最终章节。

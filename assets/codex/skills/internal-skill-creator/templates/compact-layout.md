---
scout:
  resource:
    requirement: optional
    description: 创建 layout 为 compact 的 Skill 时使用的正文结构模板。
---

# Compact Layout Template

## Selection

当 contract 可以通过模型、规则和边界直接表达，不需要必须按顺序执行的编号阶段、状态转换或完成门禁时，选择 `layout: compact` 并使用本模板。

正文较短不是选择 compact 的充分条件；判断依据是 contract 是否需要确定性执行顺序。

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
| `definitions-section-name` | 当前 contract 需要定义术语时使用的实际章节名。 |
| `definitions-used-by-this-skill` | 理解后续 contract 前必须声明的术语。 |
| `contract-section-name` | 与当前 contract 语义一致的实际章节名。 |
| `type-required-contract-content` | type template 要求的模型、contract 或规则内容。 |
| `input-name` | 一项正式输入的实际名称。 |
| `input-description` | 输入内容、来源和可推断边界。 |
| `input-boundary` | 输入缺失、冲突或不可验证时的处理规则。 |
| `conditional-section-name` | 条件内容适用时使用的实际章节名。 |
| `applicable-conditional-contract-content` | 当前条件已经成立的 contract 内容。 |
| `result-section-name` | 正式输出或结果 contract 的实际章节名。 |
| `result-and-limitation-contract` | 输出结构、所有权、限制和下游关系。 |
| `evidence-admission-and-sufficiency-rule` | 当前 Skill 已定义 evidence 时的准入或充分性门禁。 |
| `failure-fact-and-result-rule` | 失败事实、记录方式及不能形成的结果。 |
| `condition-that-blocks-dependent-work` | 必须阻塞当前或后续依赖工作的条件。 |
| `retry-precondition-limit-and-stop-rule` | 重试前提、限制和停止条件。 |
| `prohibited-behavior` | 当前 contract 无条件禁止的行为。 |
| `example-input` | 能澄清非显然决策的实际示例输入。 |
| `example-application` | 示例中应用当前 contract 的实际过程。 |
| `example-output` | 示例允许形成的实际输出。 |
| `completion-check` | 根据当前 contract 可以直接判断的完成检查。 |

目标 `SKILL.md` 按以下顺序组织：

````markdown
# <skill-title>

<purpose-and-usage>

<ownership-boundary>

## Skill Type

- type: <skill-type>
- layout: compact
- note: <responsibility-note>

## Core Use

使用本技能处理：

- <core-use-item>

不使用本技能处理：

- <core-exclusion-item>

## <definitions-section-name>

<definitions-used-by-this-skill>

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

## <result-section-name>

<result-and-limitation-contract>

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

应用：

- <example-application>

输出：

- <example-output>

## Checklist

- <completion-check>
````

`Core Use` 必须保留。只有存在容易误路由的相邻能力时，才保留其中的“`不使用本技能处理`”及 `core-exclusion-item`；否则删除这个子段。definitions、`Inputs`、conditional、result 和 `Example` 只在存在真实内容时保留，但保留时必须处于上面规定的位置。contract 章节必须存在，并承载 type template 要求的核心内容。

type template 的 Required Content 按语义写入 Core Use、definitions、contract、`Inputs` 或 result；contract 章节承载其中的核心模型和规则。只有条件成立时才适用的内容写入 conditional 章节。存在多组 conditional content 时，可以在 `Inputs` 与 result 之间按语义递进添加多个章节，不能把它们改写成编号 Phase 或伪 workflow。

门禁小节按以下语义使用：

- `Evidence Rules (Enforcement)` 定义 evidence 的来源、完整性、可验证性、准入条件和不可替代条件。
- `Failure Rules (Enforcement)` 定义失败事实如何记录，以及失败时不能形成哪些结果或结论。
- `Blocking Rules (Enforcement)` 定义必须停止当前工作或后续依赖工作的条件。
- `Retry Rules (Enforcement)` 定义允许重试的前提、次数、授权和停止条件。
- `Prohibited Rules (Enforcement)` 定义任何情况下都不得执行的行为。

只保留存在真实门禁的 Enforcement 小节。保留的小节必须按照上述顺序排列，不创建 `Workflow Exit Rules (Enforcement)` 或其它自定义门禁类别。

`Example` 只在能够澄清非显然输入、分支或结果时保留，不得把一次运行事实或特定任务结果写成通用示例。`Checklist` 必须是最终章节。

## Formatting Rules

- Scout 正式术语、字面值和单一路径使用反引号；可执行命令、多行目录结构、schema 和命名形式使用具有语言标记的 fenced code block。
- 每个占位符必须在模板中先定义再使用；完成态正文不得保留占位符。
- 每条 Enforcement rule 只表达一个可判断的条件和结果。
- 不使用 Workflow Overview、编号 Phase、Phase Exit 或 Workflow Exit Rules。
- 只在 `I-001`、`I-002` 等 Inputs 标题下使用分隔线。
- 删除所有填写说明、未替换占位符、空章节和不适用的可选章节。

## Checklist

- `layout` 是 `compact`，`type` 来自独立的 type template。
- type template 要求的内容已按 Template Application 映射到实际语义章节，没有复制 type template 标题。
- 正文不存在为了表现流程而创建的编号 Phase、Workflow Overview 或 Workflow Exit Rules。
- Core Use、definitions、model/contract、Inputs、conditional、result 和 Enforcement 按规定顺序排列。
- 术语在首次使用前声明，各章节从模型和 contract 递进到规则和检查。
- Enforcement 小节使用固定类别和顺序，不存在宽泛或自定义 rule category。
- 正式输出、状态事实、artifact、ref 和 handoff 的所有者不冲突。
- 有副作用的操作具有明确授权和重试边界。
- 不适用的小节已经删除，完成态正文不残留填写说明或占位符，Checklist 是最终章节。

---
scout:
  resource:
    requirement: required
    description: Skill type 与 layout 模板目录及选择规则。
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# Template Index

## Purpose

本文件负责 `internal-skill-creator` 的模板分类、选择和读取顺序。identity、frontmatter、phase、family、依赖和 supplementary resource 规则由上级 `SKILL.md` 定义。

- `type template` 定义一种 Skill type 必须表达的内容、责任归属和禁止越界的内容。
- `layout template` 定义一种 Skill layout 的完整正文结构、章节顺序和格式。

## Type Templates

| type | 选择条件 | template |
| --- | --- | --- |
| `domain` | 拥有一个 domain 中当前 role 的业务输入、判断、工作、输出和交接。 | `templates/domain-skill.md` |
| `tool` | 拥有一种操作能力的调用方式、输入、结果、副作用和失败边界。 | `templates/tool-skill.md` |
| `signal` | 拥有一个稳定、可组合的领域 contract。 | `templates/signal-skill.md` |
| `internal` | 拥有 Scout 自有资产、运行边界或治理规则。 | `templates/internal-skill.md` |

## Layout Templates

| layout | 选择条件 | template |
| --- | --- | --- |
| `workflow` | contract 包含必须按顺序执行的阶段、状态转换或完成门禁。 | `templates/workflow-layout.md` |
| `compact` | contract 可以通过模型、规则和边界直接表达，不需要编号执行阶段。 | `templates/compact-layout.md` |

每个 Skill 必须恰好选择一个 type template 和一个 layout template。type 与 layout 相互独立，不能根据其中一个自动选择另一个。

## Resource List

| resource | purpose | reading condition |
| --- | --- | --- |
| `templates/template-index.md` | 模板目录导航、选择和读取顺序。 | `required`。 |
| `templates/domain-skill.md` | Domain Skill 的内容责任和边界。 | `type: domain` 时读取。 |
| `templates/tool-skill.md` | Tool Skill 的内容责任和边界。 | `type: tool` 时读取。 |
| `templates/signal-skill.md` | Signal Skill 的内容责任和边界。 | `type: signal` 时读取。 |
| `templates/internal-skill.md` | Internal Skill 的内容责任和边界。 | `type: internal` 时读取。 |
| `templates/workflow-layout.md` | 有序阶段、状态和完成门禁的正文结构。 | `layout: workflow` 时读取。 |
| `templates/compact-layout.md` | 模型、规则和边界直接递进的正文结构。 | `layout: compact` 时读取。 |

## Selection Rules

- 先根据正文实际拥有的责任选择 type；不根据名称、tag、family 或当前任务名称猜测。
- 再根据 contract 是否需要确定性阶段选择 layout；正文较长或操作较多不自动等于 `workflow`。
- 两个责任拥有不同生命周期、输出或失败语义时，拆成两个 Skill，不使用宽泛 type 包装。
- 一个 Skill 同时使用两个 type templates 或两个 layout templates 时，说明责任或结构尚未收敛，必须停止并重新划分。
- type template 不规定目标 Skill 的章节、顺序或格式；layout template 不拥有任何 domain、tool、signal 或 internal 语义。
- `Skill Type` 的章节格式属于 layout template；type template 只决定其中的 type 值和应表达的责任内容。
- 不得把 type template 与 layout template 当作两套章节骨架合并。
- 模板不得重复上级 `SKILL.md` 的通用 frontmatter、family、依赖、资源或 mount 规则。

## Reading Order

1. 完整读取上级 `SKILL.md`。
2. 根据 Skill 实际拥有的责任，从 Type Templates 中选择并完整读取一个模板。
3. 根据 contract 的正文组织方式，从 Layout Templates 中选择并完整读取一个模板。
4. 按上级 `SKILL.md` 的 `Template Application` 建立 layout template 规定的正文结构，并将 type template 要求的内容放入对应位置。
5. 分别完成上级 `SKILL.md`、type template 和 layout template 的 Checklist；这些 Checklist 都是作者检查，不得逐字复制到目标 Skill。存在冲突时停止写入并先修正责任或布局选择。

## Maintenance Rules

- 本索引只做导航。
- 不在本文件中记录业务事实、证据事实、运行状态、任务状态或当前 `run` 决策。
- `templates/` 下新增任何模板后，都必须登记到本索引。
- 如果一个 Skill 拥有多个 template 文件，其 `templates/template-index.md` 必须说明用途和读取顺序。
- 如果一个 Skill 拥有 `references/`，必须创建 `references/reference-index.md`，并使用相同的“只做导航”规则。

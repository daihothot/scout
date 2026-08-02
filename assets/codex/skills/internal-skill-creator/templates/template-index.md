---
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# Template Index

## Purpose

本文件负责 `internal-skill-creator` 的类型分类、模板选择和读取顺序。通用 identity、frontmatter、`Core Use`、命名、family 路由、tag 特征 catalog、依赖和挂载规则由上级 `SKILL.md` 定义。

## Reading Order

1. 先读取上级 `SKILL.md` 的全部通用规则和通用骨架。
2. 判断当前 Skill 是否存在下表定义的差异化结构。
3. 存在时根据实际责任选择一个类型模板；不存在时只使用通用骨架。
4. 先完成通用验证；选择了类型模板时，再完成模板末尾的 `Checklist`。

## Type Catalog

| type | 选择条件 | template |
|---|---|---|
| workflow | 拥有有序执行流程、跨阶段状态、完成门禁或多产物交付。 | `templates/workflow-skill.md` |
| tool | 主要定义工具、命令、连接、权限、副作用、失败和重试的操作方法。 | `templates/tool-skill.md` |
| signal | 只定义可观察信号的稳定知识、记录结构、绑定 contract、输出 contract 和解释限制。 | `templates/signal-skill.md` |
| internal | 主要承担 Scout 内部治理，包括创建、维护 Scout 自有资产与约定，或查询内部可见边界并输出中立快照。 | `templates/internal-skill.md` |

没有独立差异化结构的 Skill 只使用上级 `SKILL.md` 的通用骨架。Skill 一旦拥有表中某类稳定责任，就必须按实际责任选择对应模板，不能用宽泛命名绕过类型规则。

## Template List

| template | 用途 | 是否必读 | 说明 |
|---|---|---|---|
| templates/template-index.md | 模板目录导航和读取顺序说明。 | 是 | 维护模板目录时必须同步更新本文件。 |
| templates/workflow-skill.md | 有序执行流程的差异化结构和必检项。 | 按类型 | 选择 `workflow` 时读取。 |
| templates/tool-skill.md | 工具操作的差异化结构和必检项。 | 按类型 | 选择 `tool` 时读取。 |
| templates/signal-skill.md | 纯信号 contract 的差异化结构和必检项。 | 按类型 | 选择 `signal` 时读取。 |
| templates/internal-skill.md | Scout 内部资产、约定、开发边界和可见边界治理的差异化结构与必检项。 | 按类型 | 选择 `internal` 时读取。 |

## Selection Rules

- 以正文实际拥有的责任分类，不根据目录前缀、family、tag、profile 或当前任务名称猜测。
- 每个 Skill 只选择一个主要类型模板；两个责任拥有不同生命周期、输出或失败语义时，应拆成两个 Skill。
- 主要定义工具接入、命令操作、连接、权限、副作用、失败或重试契约时按 `tool` 分类；Internal Skill 可以使用只读工具检查内部边界，但不拥有这些工具的操作契约。
- `signal` 是纯知识 / 纯 Contract Skill，不得包含 Inputs、Phase、Workflow 或具体操作。
- `internal` 只用于 Scout 内部治理，包括自有资产、约定、开发边界和内部可见边界检查；它不得拥有领域 workflow、工具操作契约或 Signal contract。
- 类型模板不得重复上级 `SKILL.md` 的通用 frontmatter、`Core Use`、family/tag 规则或 profile/mount 规则。

## Maintenance Rules

- 本索引只做导航。
- 不在本文件中记录业务事实、证据事实、运行状态、任务状态或当前 run 决策。
- `templates/` 下新增任何模板后，都必须登记到本索引。
- 如果一个 Skill 拥有多个模板文件，其 `templates/template-index.md` 必须说明模板用途和读取顺序。
- 如果一个 Skill 拥有 `references/`，必须创建 `references/reference-index.md`，并使用相同的“只做导航”规则。

---
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# Template Index

## Purpose

本文件索引 `scout-internal-skill-creator` 维护的可复用模板。

## Template List

| template | 用途 | 是否必读 | 说明 |
|---|---|---|---|
| templates/template-index.md | 模板目录导航和读取顺序说明。 | 是 | 维护模板目录时必须同步更新本文件。 |
| templates/internal-skill.md | 创建或规范化 Scout internal Skill 的基础结构模板。 | 是 | 创建或重构任何 Scout internal Skill 前必须读取。 |

## Maintenance Rules

- 本索引只做导航。
- 不在本文件中记录业务事实、证据事实、运行状态、任务状态或当前 run 决策。
- `templates/` 下新增任何模板后，都必须登记到本索引。
- 如果一个 Skill 拥有多个模板文件，其 `templates/template-index.md` 必须说明模板用途和读取顺序。
- 如果一个 Skill 拥有 `references/`，必须创建 `references/reference-index.md`，并使用相同的“只做导航”规则。

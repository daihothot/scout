---
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# 模板索引

## 用途

本文件索引 `guru-knowledge-research` 维护的可复用模板。

## 模板列表

| template | 用途 | 是否必读 | 说明 |
|---|---|---|---|
| templates/template-index.md | 模板目录导航和读取顺序说明。 | 是 | 维护模板目录时必须同步更新本文件。 |
| templates/research-index.md | 输出文件 `index.md` 使用的研究总览 artifact 模板。 | 是 | 这是产出的 research pack 导航产物模板，不是模板目录索引。 |
| templates/bdd-fact.md | 主 BDD fact artifact 模板。 | 是 | 在验证目标收敛到唯一 Behavior / BDD fact 后使用。 |
| templates/bdd-evidence.md | 单条 BDD evidence artifact 模板。 | 条件 | 从 `bdd-fact.md` 派生 `E-BDD-*` 独立 evidence 文件时使用。 |
| templates/knowledge-evidence.md | knowledge evidence id 的摘要聚合模板。 | 是 | 不嵌入完整 evidence block。 |
| templates/knowledge-evidence-block.md | 单条 canonical knowledge evidence artifact 模板。 | 条件 | 生成 `E-KB-*` 独立 evidence 文件时使用。 |
| templates/availability-evidence.md | 单条 availability evidence artifact 模板。 | 条件 | 生成 `E-AVAIL-*` 独立 evidence 文件时使用。 |
| templates/api-evidence.md | 单条 API semantic evidence artifact 模板。 | 条件 | 生成 `E-API-*` 独立 evidence 文件时使用，不复制 API reference 正文。 |
| templates/platform-evidence.md | 单条 platform evidence artifact 模板。 | 条件 | 生成 `E-PLATFORM-*` 独立 evidence 文件时使用。 |
| templates/code-evidence.md | code evidence 聚合模板。 | 是 | 聚合 `jarvis-codebase` 产出的 `E-CG-*` 和 `E-CODE-*` artifact refs。 |
| templates/evidence-registry.md | evidence id registry 模板。 | 是 | 索引全部 evidence ids 和 supports links。 |
| templates/verification-manual.md | verification manual 模板。 | 是 | 下游手册，只引用 evidence ids。 |

## 维护规则

- 本索引只做导航。
- 不在本文件中记录 Guru knowledge facts、code facts、research conclusions、runtime state、task status 或当前 run 决策。
- `templates/` 下新增任何模板后，都必须登记到本索引。
- `templates/research-index.md` 保留为产出 artifact `index.md` 的模板；不要重新创建 `templates/index.md` 作为模板目录导航。
- 单条 evidence 模板必须产出独立 evidence 文件；聚合模板只能登记 `artifact_ref` 和摘要字段。

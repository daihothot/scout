---
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# Template Index

## Purpose

本文件索引 `guru-knowledge-research` 维护的可复用模板。

## Template List

| template | 用途 | 是否必读 | 说明 |
|---|---|---|---|
| templates/template-index.md | 模板目录导航和读取顺序说明。 | 是 | 维护模板目录时必须同步更新本文件。 |
| templates/bdd-evidence.md | 唯一 `E-BDD-001` BDD 聚合证据模板。 | 是 | 收敛唯一 Behavior、记录候选排除过程并直接作为 `bdd-evidence.md`；不创建独立 `evidence/E-BDD-001.md`。 |
| templates/knowledge-evidence.md | 唯一 `E-KB-001` knowledge 聚合证据模板。 | 是 | 聚合 BDD、Capability、Availability 和 Platform refs；不创建独立 `evidence/E-KB-001.md`。 |
| templates/capability-evidence.md | 单条 Capability evidence artifact 模板。 | 是 | 每个相关 Capability 生成独立 `E-CAP-*`，并在其中逐项登记 11 个规格维度。 |
| templates/availability-evidence.md | Pack 级 Availability 聚合证据模板。 | 是 | 每个 Pack 只生成一份 `E-AVAIL-001`，跨相关 `E-CAP-*` 汇总目标版本可用性。 |
| templates/platform-evidence.md | Pack 级 Platform 聚合证据模板。 | 是 | 每个 Pack 只生成一份 `E-PLATFORM-001`，跨相关 `E-CAP-*` 汇总目标平台事实。 |
| templates/user-persona-evidence.md | 单条用户画像 evidence artifact 模板。 | 是 | 生成独立 `E-PERSONA-*` 并登记其画像事实和来源 evidence refs 时使用。 |
| templates/human-confirmation-evidence.md | 单条人工确认 evidence artifact 模板。 | 条件 | 将初始用户输入或正式人工回复确认的任意事实登记为 `E-HUMAN-*` 时使用。 |
| templates/code-evidence.md | code evidence 聚合模板。 | 是 | 登记 implementation claims、root/source repo provenance，并聚合 `E-CODE-*` refs。 |
| templates/evidence-registry.md | evidence id registry 模板。 | 是 | 索引全部 evidence ids 和 supports links。 |
| templates/verification-manual.md | verification manual 模板。 | 是 | 下游手册；通过 `E-PERSONA-*` 引用画像，Signals 只描述待采集数据。 |

## Maintenance Rules

- 本索引只做导航。
- 所有模板的 Markdown 标题保持英文；标题下的自然语言内容使用中文，contract 字段 key、ID 和状态值保持原样。
- 未注明 `Nice to Have，可不填写` 的事实字段默认必须取得确切信息；无法从当前输入、证据或工具结果确认时发起人工求证。
- 只有中文填写说明中明确写出 `Nice to Have，可不填写` 的字段允许缺失，且不单独触发人工求证。
- 状态、ID、ref、digest 等结构字段按中文填写说明由 workflow 生成或由 contract 校验。
- 模板不得保留无说明的空字段；产出 artifact 时必须替换全部 `<填写...>` 说明。
- 不在本文件中记录 Guru knowledge facts、code facts、research conclusions、runtime state、task status 或当前 run 决策。
- `templates/` 下新增任何模板后，都必须登记到本索引。
- 单条 evidence 模板必须产出独立 evidence 文件；聚合模板只能登记 `artifact_ref` 和摘要字段。

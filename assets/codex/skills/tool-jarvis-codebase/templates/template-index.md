---
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# Template Index

## Purpose

本文件索引 `tool-jarvis-codebase` 维护的可复用模板。

## Template List

| template | 用途 | 是否必读 | 说明 |
|---|---|---|---|
| templates/template-index.md | 模板目录导航和读取顺序说明。 | 是 | 维护模板目录时必须同步更新本文件。 |
| templates/source-code-evidence.md | `E-CODE-*` 使用的单条 source code evidence 模板。 | 是 | 记录可重放 locator、唯一 primary symbol、key lines、CodeGraph 查询与源码采集命令、supports 和 limitations。 |

## Maintenance Rules

- 本索引只做导航。
- 所有模板的 Markdown 标题保持英文；标题下的自然语言内容使用中文，contract 字段 key、ID、symbol、命令和状态值保持原样。
- 未注明 `Nice to Have，可不填写` 的事实字段默认必须取得确切信息；明确可不填写的字段缺失不阻塞 evidence 形成。
- 状态、ID、ref 等结构字段按中文填写说明由 workflow 生成或由 contract 校验。
- 模板不得保留无说明的空字段；产出 evidence artifact 时必须替换全部 `<填写...>` 说明。
- 不在本文件中记录 code facts、CodeGraph results、research conclusions、runtime state、task status 或当前 run 决策。
- `templates/` 下新增任何模板后，都必须登记到本索引。

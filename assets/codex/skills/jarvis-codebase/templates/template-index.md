---
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# 模板索引

## 用途

本文件索引 `jarvis-codebase` 维护的可复用模板。

## 模板列表

| template | 用途 | 是否必读 | 说明 |
|---|---|---|---|
| templates/template-index.md | 模板目录导航和读取顺序说明。 | 是 | 维护模板目录时必须同步更新本文件。 |
| templates/codegraph-evidence.md | `E-CG-*` 使用的单条 CodeGraph evidence 模板。 | 是 | 记录 query command、matched symbol、matched file、relation 和 located symbols。 |
| templates/source-code-evidence.md | `E-CODE-*` 使用的单条 source code evidence 模板。 | 是 | 记录 symbol lines、key lines、collection commands、supports 和 limitations。 |

## 维护规则

- 本索引只做导航。
- 不在本文件中记录 code facts、CodeGraph results、research conclusions、runtime state、task status 或当前 run 决策。
- `templates/` 下新增任何模板后，都必须登记到本索引。

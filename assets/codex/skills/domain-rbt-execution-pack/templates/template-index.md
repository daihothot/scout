---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 模板目录与读取顺序。
artifact_type: TemplateIndex
artifact_version: 1
status: ready
---

# Template Index

## Purpose

本文件索引 `domain-rbt-execution-pack` 维护的全部 required templates。

## Resource List

| resource | purpose | reading condition |
| --- | --- | --- |
| `templates/template-index.md` | 模板导航和读取顺序。 | `required`。 |
| `templates/execution-pack.md` | Pack、Behavioral identity、Agent 侧计划和 artifact refs。 | `required`。 |
| `templates/execute-file.md` | 可重放 `execute-file.json` 的结构和边界。 | `required`。 |
| `templates/bdd-evidence.md` | 唯一 BDD evidence。 | `required`。 |
| `templates/code-evidence.md` | 当前业务代码 evidence refs 和 implementation claim 聚合。 | `required`。 |
| `templates/source-code-evidence.md` | 每个 `E-CODE-*` 的独立当前版本业务源码证据。 | 生成任一 `E-CODE-*` 时 `required`。 |
| `templates/journal-expected.md` | 按相对顺序登记的预期 Campaign Journal records。 | `required`。 |
| `templates/signal-expected.md` | 当前执行计划的全部 Signal expectation、具体值和代码证据链。 | `required`。 |
| `templates/human-input-evidence.md` | Human Input request、response 和计划影响。 | `required`。 |
| `templates/evidence-registry.md` | 全部稳定 ID 与引用关系。 | `required`。 |

## Reading Order

1. 先读 `execution-pack.md`、`bdd-evidence.md` 和 `code-evidence.md`，建立 BDD / 目标版本 / Behavioral identity、required Given Hook mapping 与来源边界；需要生成 `E-CODE-*` 时同时读取 `source-code-evidence.md`。
2. 再读 `journal-expected.md`、`signal-expected.md` 和 `human-input-evidence.md`，建立预期流程、预期 Signal 结果、匹配规则和人工往返事实。
3. 读取 `execute-file.md`，把最终计划写成与 Pack 同版本的可重放 `command + payload` 序列。
4. 最后读 `evidence-registry.md`，闭合 Agent 侧内容的全部引用。

## Maintenance Rules

- 本索引只做导航，不记录当前 BDD、Runtime、task 或执行事实。
- 模板 frontmatter 中的 `scout.resource` 只控制资源物化，生成 artifact 时不得复制。
- 模板中的英文 Markdown headings、字段 keys、ID、status、command、schema 字段、Runtime identity、symbol、文件系统 path、URL、version 和其它原始技术值保持原样。
- 新增、删除、重命名模板或改变职责时必须同步本索引。
- 所有 `<填写...>` 说明必须在生成 artifact 时替换；不适用的条件行应删除，不能留空。

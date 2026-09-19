---
scout:
  resource:
    requirement: required
    description: RBT Execution Pack 原子 artifact 模板目录与读取顺序。
artifact_type: TemplateIndex
artifact_version: 4
---

# Template Index

## Resource List

| resource | purpose | reading condition |
| --- | --- | --- |
| `templates/template-index.md` | 原子 artifact 导航和读取顺序。 | `required`。 |
| `templates/bdd-evidence.md` | 本次执行采用的唯一 BDD/case 事实。 | `required`。 |
| `templates/source-code-evidence.md` | 当前版本单个源码 symbol 事实。 | 生成任一 `E-CODE-*` 时 `required`。 |
| `templates/journal-expected.md` | 有顺序和关键 identity 的 `JR-*` 观察表。 | `required`。 |
| `templates/signal-expected.md` | 完整、可独立比较的 `SR-*` expectations。 | `required`。 |
| `templates/human-input-evidence.md` | Human Input request、response 和计划影响。 | `required`。 |
| `templates/execute-file.md` | 可重放 `execute-file.json` 的结构和边界。 | `required`。 |

## Reading Order

1. 读取 `bdd-evidence.md`，确认本次 BDD/case 及其 Given/When/Then locators。
2. 按实际业务路径读取 `source-code-evidence.md`，为每个必需源码事实生成独立 `E-CODE-*`。
3. 读取 `signal-expected.md`，为每条可独立定位和判断的 Evidence 建立完整 `SR-*`。
4. 读取 `journal-expected.md`，用表格列出 Journal 观察点、关键 identity、预期顺序和向下引用的 SR。
5. 读取 `human-input-evidence.md`，记录已接受 Human Input 事实或 `none`。
6. 读取 `execute-file.md`，写入与上述预期对齐的唯一可重放命令序列。

## Maintenance Rules

- 本索引只做导航，不记录当前 BDD、Runtime、task 或执行事实。
- 模板 frontmatter 中的 `scout.resource` 只控制资源物化，生成 artifact 时不得复制。
- 各 artifact 使用直接 refs 建立关系；不创建 manifest、code aggregate 或 registry。
- 引用只允许上层指向下层：`JR-* -> SR-* -> E-BDD-*/E-CODE-*`；底层 artifact 不登记消费者。
- 新增、删除、重命名模板或改变职责时必须同步本索引。

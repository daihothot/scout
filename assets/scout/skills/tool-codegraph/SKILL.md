---
assetKind: scout.skill
name: tool-codegraph
description: 使用 CodeGraph 在已确认的代码库路径和版本中定位文件、符号、调用关系与源码范围。
id: tool-codegraph
version: 0.1.0
type: tool
family: [tool, codegraph]
tags: [codegraph, index, symbol, source, query]
devices: [any]
dependencies:
  shellTools:
    required: [scoutAssets, codegraph]
    optional: [rg, sed, cat]
summary: 从已知文件或符号开始窄查询，仅在无法定位时逐步扩大 CodeGraph 搜索范围。
---

# CodeGraph Tool

当当前 `<role>` 已经取得固定代码库路径和版本，需要定位源码文件、符号、调用关系或影响范围时，使用本技能。

本技能只负责 CodeGraph 的索引检查、查询顺序与结果定位。代码库准备、路径解析和版本选择由提供这些输入的 Skill 负责；业务判断和 artifact 格式由消费结果的 Skill 负责。

## Inputs

Required：

- `codebase_path`：当前代码库的绝对路径。
- `version`：当前已确认的代码版本。
- `target`：已知文件、类型、方法、API 或其它尽可能精确的符号线索。

Missing：

- 缺少代码库路径或版本时，不执行查询，返回缺失项。
- 缺少精确线索时，先向上游取得文件、类型、方法或 API；不得直接用宽泛业务描述拉取大量候选。

Confirmation：

- 查询均显式使用同一个 `codebase_path`。
- 最终定位包含相对文件路径、符号名和可回读的源码范围。
- CodeGraph 结果已通过当前源码核对；索引结果本身不替代源码事实。

## Commands

| 目的 | 命令 |
| --- | --- |
| 检查索引 | `codegraph status "<codebase_path>" -j` |
| 精确查找候选 | `codegraph query "<symbol>" -p "<codebase_path>" -l 5` |
| 按类型收窄 | `codegraph query "<symbol>" -p "<codebase_path>" -k <kind> -l 5` |
| 定位文件中的符号 | `codegraph node "<symbol>" -p "<codebase_path>" -f "<relative_file>"` |
| 分页读取文件节点 | `codegraph node "<relative_file>" -p "<codebase_path>" --offset <n> --limit <n>` |
| 查询调用方 | `codegraph callers "<symbol>" -p "<codebase_path>"` |
| 查询被调用方 | `codegraph callees "<symbol>" -p "<codebase_path>"` |
| 查询影响范围 | `codegraph impact "<symbol>" -p "<codebase_path>"` |
| 有界主题扩展 | `codegraph explore "<topic>" -p "<codebase_path>" --max-files 5` |
| 最后检查索引文件 | `codegraph files -p "<codebase_path>"` |

参数含义和实际可用选项以当前 `codegraph <command> --help` 为准。本技能规定查询顺序，不复制 CLI 的完整帮助。

## Query Order

1. 使用固定的 `codebase_path` 执行 `status -j`，确认索引可读。
2. 已知文件和符号时，先用 `node -f` 直接定位。
3. 只知道符号时，用 `query -l 5`；已知 kind 时同时传 `-k`。
4. 找到唯一符号后，按问题需要查询 `callers`、`callees` 或 `impact`。
5. 回读命中的当前源码，确认实际声明、分支和调用顺序。
6. 只有前述窄查询无法定位时，才使用 `explore --max-files 5` 扩展一次。
7. 仍无法定位时，才使用 `files` 或更宽的查询，并说明扩大范围的原因。

## Constraints

- 每条查询都必须显式传入 `-p "<codebase_path>"`。
- 禁止从宽泛自然语言 `query`、`explore` 或完整 `files` 列表开始。
- 禁止用大 limit 一次拉取完整候选集；默认最多读取 5 个候选，再根据命中结果继续收窄。
- 禁止把 CodeGraph 摘要直接当作源码证据；必须回读命中的源码范围。
- 禁止自行执行索引创建、刷新、同步、解锁或修复操作。索引不可用时返回状态与失败原因，由拥有代码库生命周期的 Skill 处理。
- 输出只保留有用 locator、关系和必要 provenance，不复制无关的大段查询正文。

## Result

返回：

- `codebase_path` 与 `version`；
- 命中的相对文件、符号和源码范围；
- 与问题直接相关的调用关系；
- 实际执行的窄查询，以及发生扩展时的原因；
- 未定位、歧义、索引不可用或源码不一致等限制。

## Exit

- 已定位并核对回答当前问题所需的最小源码集合；或
- 索引、路径、版本或目标线索不足，已返回明确 blocker；或
- 有界扩展后仍无法定位，已返回查询范围和缺失信息。

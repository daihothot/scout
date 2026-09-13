---
scout:
  resource:
    requirement: required
    description: 当前代码符号与仓库来源证据模板。
evidence_id: E-CODE-001
evidence_type: source_code
status: candidate
---

# E-CODE-001

## Artifact State

- status: <填写 candidate、source_verified 或 blocked，并与 frontmatter 保持一致>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>

状态枚举：

- status: candidate | source_verified | blocked

## Claim

- <填写由当前 managed codebase version、primary symbol、signature 和 key lines 直接支持的 source symbol evidence claim>

## Codebase

- codebase: <填写当前 managed codebase 名称>
- version: <填写当前 managed codebase 的版本号>
- codegraph_status: <填写收集源码前确认的 CodeGraph 状态>

## Source Locator

- source_relative_file: <填写相对 managed codebase 的源码路径>
- canonical_locator: <填写 version:source_relative_file>

## Primary Symbol

- name: <填写 primary symbol 名称>
- type: <填写 primary symbol 类型>
- start_line: <填写 symbol 起始行号>
- end_line: <填写 symbol 结束行号>
- signature: <填写当前源码中的完整 symbol signature>

## Key Lines

| 行号 | 原因 |
|---:|---|
| <填写支撑 source symbol evidence claim 的关键行号> | <填写这些行能够支撑该源码语义的原因> |

## Collection

- method: <填写本次源码证据的收集方法>
- query_result_summary: <填写 CodeGraph 命中的候选符号、文件和关系摘要>
- commands:
  - `<填写实际执行的只读源码命令>`

## Supports

- <填写使用方 artifact contract 定义的实际 claim 或 requirement IDs；没有时填写 none>

## Limitations

- 源码 evidence 只拥有 source symbol evidence claim；业务 implementation claim 由上游 `code-evidence.md` 定义，它也不能证明该行为已经在运行时触发。
- 每个 `E-CODE-*` 只允许一个 primary symbol；多个独立 symbol 必须拆成多个 evidence artifact。
- `source_verified` 要求 `canonical_locator` 可由 `version + source_relative_file` 定位，且 primary symbol、signature 和 key lines 来自该版本的实际源码。
- Knowledge 只能作为定位线索，不能代替实际源码填写 `source_relative_file`、`Primary Symbol`、行号、signature 或 key lines。

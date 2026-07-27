---
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

- <填写当前版本源码能够支持的 implementation claim>

## Repository Provenance

- root_repo: <填写 managed root repository 名称>
- root_version: <填写当前代码库声明的版本号>
- root_branch: <填写收集证据时的 branch>
- root_commit: <填写收集证据时的完整 commit>
- root_worktree_state: <填写 clean 或具体修改状态>
- root_codebase_path: <填写本次 run 解析出的 managed checkout 路径>
- source_repo: <填写实际拥有目标源码的仓库名称>
- source_version: <填写 source repository 当前版本号>
- source_branch: <填写 source repository 当前 branch>
- source_commit: <填写 source repository 完整 commit>
- source_worktree_state: <填写 clean 或具体修改状态>
- source_codebase_path: <填写本次 run 解析出的 source repository 路径>
- gitlink_path: <非嵌套仓库填写 none，否则填写 root 中的 gitlink 路径>
- gitlink_commit: <非嵌套仓库填写 none，否则填写 root commit 记录的 gitlink commit>
- gitlink_matches_source_commit: <填写 true 或 false>
- codegraph_status: <填写收集源码前确认的 CodeGraph 状态>

## Replay Locator

- source_relative_file: <填写相对 source repository 的源码路径>
- source_file_worktree_state: <填写目标源码文件的 clean 或具体修改状态>
- canonical_locator: <填写 source_commit:source_relative_file>

## Primary Symbol

- name: <填写 primary symbol 名称>
- type: <填写 primary symbol 类型>
- start_line: <填写 symbol 起始行号>
- end_line: <填写 symbol 结束行号>
- signature: <填写当前源码中的完整 symbol signature>

## Key Lines

| 行号 | 原因 |
|---:|---|
| <填写支撑 claim 的关键行号> | <填写这些行能够支撑 claim 的原因> |

## Collection

- method: <填写本次源码证据的收集方法>
- query_result_summary: <填写 CodeGraph 命中的候选符号、文件和关系摘要>
- commands:
  - `<填写实际执行的只读源码命令>`

## Supports

- VP-001
- F-001

## Limitations

- 源码 evidence 证明当前版本包含该实现；它不能证明该行为已经在运行时触发。
- 每个 `E-CODE-*` 只允许一个 primary symbol；多个独立 symbol 必须拆成多个 evidence artifact。
- `source_verified` 要求目标源码文件对 `source_commit` 保持 clean，且 `canonical_locator` 可由 `source_commit + source_relative_file` 重放。

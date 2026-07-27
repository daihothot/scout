---
artifact_type: CodeEvidencePack
artifact_version: 1
status: draft
completion_state: partial
---

# Code Evidence

## Code Evidence State

- status: <填写 draft、ready 或 blocked，并与 frontmatter 保持一致>
- completion_state: <填写 partial、complete 或 blocked，并与 status 组成合法状态>
- blocking_items: <无阻塞项时填写 none，否则说明阻塞事实>
- failed_commands: <无失败命令时填写 none，否则记录命令及错误摘要>
- retry_log: <无重试时填写 none，否则记录重试命令和结果>
- limitations: <没有已知限制时填写 none，否则说明代码证据的适用边界>

状态枚举：

- `draft + partial`
- `ready + complete`
- `blocked + blocked`

## Root Repository Provenance

- root_repo: <填写 managed root repository 名称>
- root_version: <填写当前代码库声明的版本号>
- root_branch: <填写收集证据时的 branch>
- root_commit: <填写收集证据时的完整 commit>
- root_worktree_state: <填写 clean 或具体修改状态>
- root_codebase_path: <填写本次 run 解析出的 managed checkout 路径>

## Source Repository Provenance

| source_id | source_repo | source_version | source_branch | source_commit | source_worktree_state | source_codebase_path | gitlink_path | gitlink_commit | codegraph_status |
|---|---|---|---|---|---|---|---|---|---|
| SRC-001 | <填写实际拥有目标源码的仓库名称> | <填写源码仓库版本> | <填写源码仓库 branch> | <填写源码仓库完整 commit> | <填写 clean 或具体修改状态> | <填写源码仓库路径> | <非嵌套仓库填写 none，否则填写 gitlink 路径> | <非嵌套仓库填写 none，否则填写 gitlink commit> | <填写查询时确认的 CodeGraph 状态> |

## Scope

- source_query_targets: <填写本文件登记的 SQT-* 引用>

## Source Query Targets

| target_id | derived_from | query_target | expected_claim |
|---|---|---|---|
| SQT-001 | <填写推导该查询目标的 evidence ids> | <填写需要定位的源码语义目标> | <填写需要由代码证据确认的 implementation claim> |

## Implementation Claims

| claim_id | claim | source_id | code_evidence | limitations |
|---|---|---|---|---|
| IC-001 | <填写当前版本代码能够支持的 implementation claim> | <填写 SRC-* 引用> | <填写 E-CODE-* 引用> | <填写该 claim 的额外限制；Nice to Have，可不填写> |

## Source Code Evidence Refs

| evidence_id | artifact_ref | source | locator | claim_supported | supports | limitations |
|---|---|---|---|---|---|---|
| E-CODE-001 | <填写独立 source code evidence artifact ref> | <填写 SRC-* 引用> | <填写 source commit、相对路径、symbol 和行号> | <填写 source code evidence 能够支持的 claim> | <填写 IC-* 或 VP-* 引用> | <填写额外限制；Nice to Have，可不填写> |

## Aggregation Notes

- `E-CODE-*` artifact refs 由 `tool-jarvis-codebase` 产出；CodeGraph 查询过程记录在对应 `E-CODE-*` 的 `Collection`。
- 本文件只聚合 refs 和 claim mapping；它不能替代 source evidence artifacts。
- Implementation claims 只登记在本文件中；`knowledge-evidence.md` 记录 intent / spec / behavior evidence，`verification-manual.md` 只引用 evidence ids。

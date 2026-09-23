---
scout:
  resource:
    requirement: required
    description: 当前版本代码证据聚合模板。
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

## Codebase

- codebase: <填写当前 managed codebase 名称>
- version: <填写当前 managed codebase 的版本号>
- codebase_path: <填写本次 run 解析出的 managed codebase 路径>
- codegraph_status: <填写查询时确认的 CodeGraph 状态>

## Scope

- source_query_targets: <填写本文件登记的 SQT-* 引用>

## Source Query Targets

| target_id | derived_from | query_target | expected_claim |
|---|---|---|---|
| SQT-001 | <填写推导该查询目标的 evidence ids> | <填写需要定位的源码语义目标> | <填写需要由代码证据确认的 implementation claim> |

## Implementation Claims

| claim_id | claim | codebase | code_evidence | limitations |
|---|---|---|---|---|
| IC-001 | <填写当前版本代码能够支持的 implementation claim> | <填写 codebase 名称> | <填写 E-CODE-* 引用> | <填写该 claim 的额外限制；Nice to Have，可不填写> |

## Source Code Evidence Refs

| evidence_id | artifact_ref | codebase | locator | claim_supported | supports | limitations |
|---|---|---|---|---|---|---|
| E-CODE-001 | <填写独立 source code evidence artifact ref> | <填写 codebase 名称> | <填写 version、相对路径、symbol 和行号> | <填写 source code evidence 能够支持的 claim> | <填写 IC-* 或 VP-* 引用> | <填写额外限制；Nice to Have，可不填写> |

## Aggregation Notes

- `E-CODE-*` artifact refs 由 `tool-jarvis-codebase` 产出；CodeGraph 查询过程记录在对应 `E-CODE-*` 的 `Collection`。
- 本文件只聚合 refs 和 claim mapping；它不能替代 source evidence artifacts。
- Implementation claims 只登记在本文件中；`knowledge-evidence.md` 记录 intent / spec / behavior evidence，`verification-manual.md` 只引用 evidence ids。
